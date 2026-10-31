/**
 * Task #1287 route-level AutoFlow aggregation smoke.
 *
 * This loads the real dashboard route with only its external services stubbed,
 * captures the pipeline passed to Mongo, and evaluates the status/grouping
 * portion with a small Mongo-expression interpreter.  The existing pure
 * classifier test is intentionally not used here: this catches a route
 * pipeline typo or an unsupported expression that would otherwise leave the
 * production dashboard empty.
 *
 * Run:
 * NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
 *   npx tsx tests/autoflow-dashboard-aggregation.smoke.ts
 */
import Module from "node:module";
import { NextRequest } from "next/server";

let failed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function pathValue(doc: any, path: string): any {
  return path.split(".").reduce((value, key) => value == null ? undefined : value[key], doc);
}

function evaluate(expr: any, doc: any, vars: Record<string, any> = {}): any {
  if (typeof expr === "string" && expr.startsWith("$$")) {
    const [name, ...parts] = expr.slice(2).split(".");
    const base = vars[name];
    return parts.length ? pathValue(base, parts.join(".")) : base;
  }
  if (typeof expr === "string" && expr.startsWith("$")) return pathValue(doc, expr.slice(1));
  if (!expr || typeof expr !== "object" || Array.isArray(expr)) return expr;
  const entries = Object.entries(expr);
  if (entries.length !== 1) return expr;
  const [operator, value] = entries[0] as [string, any];
  switch (operator) {
    case "$ifNull": {
      const result = evaluate(value[0], doc, vars);
      return result == null ? evaluate(value[1], doc, vars) : result;
    }
    case "$toString": return String(evaluate(value, doc, vars));
    case "$convert": {
      const input = evaluate(value.input, doc, vars);
      if (input == null) return value.onNull;
      if (value.to === "string") {
        if (typeof input === "object") return value.onError;
        return String(input);
      }
      return value.onError;
    }
    case "$toLower": return String(evaluate(value, doc, vars)).toLowerCase();
    case "$toUpper": return String(evaluate(value, doc, vars)).toUpperCase();
    case "$trim": return String(evaluate(value.input, doc, vars)).trim();
    case "$regexFindAll": {
      const input = String(evaluate(value.input, doc, vars));
      return [...input.matchAll(new RegExp(value.regex, "g"))].map((match) => ({ match: match[0] }));
    }
    case "$reduce": {
      let result = evaluate(value.initialValue, doc, vars);
      for (const item of evaluate(value.input, doc, vars) || []) {
        result = evaluate(value.in, doc, { ...vars, value: result, this: item });
      }
      return result;
    }
    case "$concat": return value.map((item: any) => String(evaluate(item, doc, vars))).join("");
    case "$in": {
      const [needle, haystack] = value;
      return evaluate(haystack, doc, vars).includes(evaluate(needle, doc, vars));
    }
    case "$eq": return evaluate(value[0], doc, vars) === evaluate(value[1], doc, vars);
    case "$ne": return evaluate(value[0], doc, vars) !== evaluate(value[1], doc, vars);
    case "$gt": return evaluate(value[0], doc, vars) > evaluate(value[1], doc, vars);
    case "$and": return value.every((item: any) => Boolean(evaluate(item, doc, vars)));
    case "$or": return value.some((item: any) => Boolean(evaluate(item, doc, vars)));
    case "$cond": return evaluate(value[0], doc, vars) ? evaluate(value[1], doc, vars) : evaluate(value[2], doc, vars);
    default: throw new Error(`unsupported test expression ${operator}`);
  }
}

function matches(doc: any, filter: any): boolean {
  for (const [key, condition] of Object.entries(filter || {})) {
    if (key === "$expr") {
      if (!evaluate(condition, doc)) return false;
      continue;
    }
    const value = pathValue(doc, key);
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      if ("$in" in condition && !(condition as any).$in.includes(value)) return false;
      if ("$gte" in condition && !(value >= (condition as any).$gte)) return false;
      if ("$ne" in condition && value === (condition as any).$ne) return false;
      if ("$type" in condition && (condition as any).$type === "string" && typeof value !== "string") return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function earlyPipeline(input: any[], pipeline: any[]): any[] {
  let docs = input.map((doc) => ({ ...doc }));
  for (const stage of pipeline.slice(0, 7)) {
    if (stage.$match) {
      docs = docs.filter((doc) => matches(doc, stage.$match));
    } else if (stage.$addFields) {
      docs = docs.map((doc) => {
        const copy = { ...doc };
        for (const [key, expression] of Object.entries(stage.$addFields)) {
          copy[key] = evaluate(expression, doc);
        }
        return copy;
      });
    } else if (stage.$set) {
      docs = docs.map((doc) => {
        const copy = { ...doc };
        for (const [key, expression] of Object.entries(stage.$set)) {
          copy[key] = evaluate(expression, doc);
        }
        return copy;
      });
    } else if (stage.$sort) {
      docs.sort((a, b) => {
        for (const [key, direction] of Object.entries(stage.$sort) as [string, number][]) {
          if (pathValue(a, key) > pathValue(b, key)) return direction;
          if (pathValue(a, key) < pathValue(b, key)) return -direction;
        }
        return 0;
      });
    } else if (stage.$group) {
      const grouped = new Map<string, any>();
      for (const doc of docs) {
        const id = evaluate(stage.$group._id, doc);
        const key = JSON.stringify(id);
        if (!grouped.has(key)) grouped.set(key, { _id: id });
        const output = grouped.get(key);
        for (const [field, accumulator] of Object.entries(stage.$group)) {
          if (field === "_id") continue;
          if ((accumulator as any).$first) output[field] ??= doc;
          if ((accumulator as any).$max) {
            output[field] ??= null;
            const cond = (accumulator as any).$max.$cond;
            const candidate = evaluate(cond[0], doc)
              ? evaluate(cond[1], doc)
              : evaluate(cond[2], doc);
            if (candidate != null && (output[field] == null || candidate > output[field])) output[field] = candidate;
          }
        }
      }
      docs = [...grouped.values()];
    } else if (stage.$replaceRoot) {
      docs = docs.map((doc) => evaluate(stage.$replaceRoot.newRoot, doc));
    } else {
      throw new Error(`unsupported test pipeline stage ${Object.keys(stage).join(",")}`);
    }
  }
  return docs;
}

let capturedPipeline: any[] | null = null;
const originalLoad = (Module as any)._load;
const authStub = {
  getSession: async () => ({
    token: "test",
    shopId: 432,
    email: "test@example.com",
    role: "owner",
    isPlatformAdmin: true,
  }),
};
const workflowStub = {
  getAutoflowWorkflowMapping: async () => ({
    active: ["Checkin", "Servicing"],
    closed: ["Close"],
    excluded: ["Appointment"],
  }),
  InvalidAutoflowWorkflowMappingError: class extends Error {},
};
const mergeStub = (primary: any[], auto: any[]) => ({ rows: [...primary, ...auto] });

function cursor(rows: any[] = []) {
  const chain: any = {
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    project: () => chain,
    toArray: async () => rows,
  };
  return chain;
}

const events = [
  { shopId: "432", provider: "autoflow", vehicleVin: "VIN-A", receivedAt: new Date("2026-09-17T12:00:00Z"), payload: { ticket: { status: "Servicing" } } },
  { shopId: "432", provider: "autoflow", vehicleVin: "VIN-A", receivedAt: new Date("2026-09-17T11:00:00Z"), payload: { ticket: { status: "Appointment" } } },
  { shopId: "432", provider: "autoflow", vehicleVin: "VIN-A", receivedAt: new Date("2026-09-17T10:00:00Z"), payload: { ticket: { status: "Checkin" } } },
  { shopId: "432", provider: "autoflow", vehicleVin: "VIN-B", receivedAt: new Date("2026-09-17T12:00:00Z"), payload: { ticket: { status: "Close" } } },
  { shopId: "432", provider: "autoflow", vehicleVin: "VIN-B", receivedAt: new Date("2026-09-17T10:00:00Z"), payload: { ticket: { status: "Checkin" } } },
  { shopId: "432", provider: "autoflow", vehicleVin: "VIN-C", receivedAt: new Date("2026-09-17T12:00:00Z"), payload: { ticket: { status: { malformed: true } } } },
  { shopId: "432", provider: "autoflow", vehicleVin: "VIN-D", receivedAt: new Date("2026-09-17T12:00:00Z"), payload: { ticket: {} } },
];

// Preserve event ordering without letting these active fixtures age out of the
// real route's rolling 30-day window as the calendar advances.
const originalEventTimes = events.map(event => +event.receivedAt);
function refreshFixtureDates(now: number) {
  const shift = now - Date.parse("2026-09-17T13:00:00Z");
  events.forEach((event, index) => { event.receivedAt = new Date(originalEventTimes[index] + shift); });
}
let groupedVins: string[] = [];

const dbStub = {
  collection(name: string) {
    return {
      findOne: async () => name === "shops"
        ? { shopId: 432, autoflow: { apiKey: "test" }, preferences: {} }
        : null,
      find: () => cursor([]),
      countDocuments: async () => 0,
      aggregate: (pipeline: any[]) => {
        if (name !== "events") return { toArray: async () => [] };
        capturedPipeline = pipeline;
        const grouped = earlyPipeline(events, pipeline);
        groupedVins = grouped.map(row => row._id);
        return {
          toArray: async () => grouped.map(({ latest, _id }) => ({
            displayName: "Grand Rapids",
            displayVehicle: "2020 Ford",
            displayVin: _id,
            displayMiles: 1,
            displayRo: "RO-1",
            dviDone: true,
            updatedAt: latest.receivedAt,
            af: { status: latest.statusRaw, miles: 1, createdAt: latest.receivedAt },
          })),
        };
      },
    };
  },
};

(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "@/lib/auth" || request.endsWith("/lib/auth")) return authStub;
  if (request === "@/lib/mongo" || request.endsWith("/lib/mongo")) return { getDb: async () => dbStub };
  if (request.includes("data/repositories/autoflow-workflows")) return workflowStub;
  if (request.includes("featureResolver")) return { getFeatureEntitlements: async () => ({ canUseFeature: () => true, effectiveFeatures: {} }) };
  if (request.includes("dataone-local")) return { getBatchQuickSpecs: async () => ({}) };
  if (request.includes("integrations/carfax")) return { fetchCarfaxWithCache: async () => ({ ok: false }) };
  if (request.includes("dashboard/autoflow-merge")) return { mergeAutoflowIntoPrimary: mergeStub };
  if (request.endsWith("dashboard-search") || request.includes("dashboard-search")) return { prefixRegex: () => /.*/, vinPrefix: (value: string) => value };
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const route = require("../app/api/dashboard/data/route");
  const GET = route.GET || (route.default as any)?.GET;
  if (typeof GET !== "function") {
    console.error("dashboard route exports", Object.keys(route), typeof route.GET, Object.keys((route as any).default || {}));
    throw new Error("dashboard GET handler did not load");
  }
  const realNow = Date.now;
  try {
  for (const now of [realNow(), Date.parse("2026-10-31T20:40:32Z"), Date.parse("2027-12-31T23:00:00Z")]) {
  Date.now = () => now;
  refreshFixtureDates(now);
  capturedPipeline = null;
  groupedVins = [];
  const response = await GET(new NextRequest("http://localhost/api/dashboard/data?page=1"));
  const body = await response.json();
  const pipeline = capturedPipeline as any[] | null;
  // Only synthetic fixture identifiers and structural response data; no body,
  // customer fields, authentication data, or raw error messages.
  const diagnostics = JSON.stringify({
    now: new Date(now).toISOString(), status: response.status,
    rowCount: Array.isArray(body.rows) ? body.rows.length : null,
    groupedVins, pipelineStages: pipeline?.length ?? 0,
  });
  ok("dashboard route succeeds", response.status === 200, diagnostics);
  ok("dashboard route returns the captured active AutoFlow row", body.rows?.some((row: any) => row.displayVin === "VIN-A"), diagnostics);
  ok("aggregation returns exactly the active fixture", JSON.stringify(groupedVins) === '["VIN-A"]', diagnostics);
  ok("closed VIN is absent from the captured aggregation result", !body.rows?.some((row: any) => row.displayVin === "VIN-B"), diagnostics);
  ok("malformed non-string status is safely inactive", !body.rows?.some((row: any) => row.displayVin === "VIN-C"), diagnostics);
  ok("missing status is safely inactive", !body.rows?.some((row: any) => row.displayVin === "VIN-D"), diagnostics);
  ok("captured dashboard pipeline exists", Array.isArray(pipeline));

  const lookups = (pipeline || []).filter((stage) => stage.$lookup);
  for (const collection of ["dvi_results", "dvi"]) {
    const lookup = lookups.find((stage) => stage.$lookup.from === collection)?.$lookup;
    const serialized = JSON.stringify(lookup || {});
    ok(`${collection} lookup scopes by shop`, /shopId/.test(serialized));
    ok(`${collection} lookup has a tenant-aware expression`, /\$eq.*shopId|shopId.*\$eq/.test(serialized));
  }
  const cutoff = pipeline?.[0]?.$match?.receivedAt?.$gte;
  ok("production window remains exactly 30 days", +cutoff === now - 30 * 86400000, diagnostics);
  const staleEvents = events.map(event => ({ ...event, receivedAt: new Date(now - 31 * 86400000) }));
  ok("old active events remain outside the window", earlyPipeline(staleEvents, pipeline || []).length === 0, diagnostics);
  }
  } finally {
    Date.now = realNow;
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  (Module as any)._load = originalLoad;
});