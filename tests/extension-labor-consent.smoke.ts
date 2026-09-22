/**
 * Task #1292 — existing-job labor-rate consent boundary.
 *
 * Executes the real background orchestration and both mutation sinks in a VM
 * with an offline Tekmetric transport. Every job returned by this fixture is
 * pre-existing; neither a manual Apply Now nor automatic application gets a
 * broader permission.
 *
 * Run: npx tsx tests/extension-labor-consent.smoke.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const root = join(__dirname, "..");
const background = readFileSync(
  join(root, "mos-tools-extension", "background.js"),
  "utf8",
);
const core = readFileSync(
  join(root, "mos-tools-extension", "labor-rate-core.js"),
  "utf8",
);

function extract(startMarker: string, endMarker: string) {
  const start = background.indexOf(startMarker);
  const end = background.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing boundary ${startMarker}`);
  return background.slice(start, end);
}

const matching = extract(
  "function matchRuleCondition(",
  "// ==================== TEKMETRIC INSPECTION FETCH",
);
const autoApply = extract(
  "async function autoApplyLaborRate(",
  "async function applyLaborRatePerJob(",
);
const perJob = extract(
  "async function applyLaborRatePerJob(",
  "async function applyLaborRateToRO(",
);
const roDefault = extract(
  "async function applyLaborRateToRO(",
  'console.log("[MOS Tools] Background service worker loaded")',
);

type Rule = Record<string, any>;
type Job = Record<string, any>;
type Write = {
  endpoint: string;
  method: string;
  jobId?: number;
  name?: string;
  rates?: number[];
};

const state: {
  rules: Rule[];
  ro: Record<string, any>;
  jobs: Job[];
  writes: Write[];
  failedJobIds: Set<number>;
} = {
  rules: [],
  ro: {},
  jobs: [],
  writes: [],
  failedJobIds: new Set(),
};

function response(
  body: any,
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
) {
  return {
    ok,
    status,
    json: async () => structuredClone(body),
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  };
}

const quietConsole = {
  log() {},
  warn() {},
  error() {},
  debug() {},
};

const sandbox: any = {
  console: quietConsole,
  structuredClone,
  _stateReady: Promise.resolve(),
  ensureBootstrapBoundToActiveTab: async () => {},
  mosApiToken: "offline-mos-token",
  mosSessionTier: { canMutate: true },
  captureLaborRateContext: (context: any) => ({
    ...context,
    __laborRateSnapshot: true,
  }),
  assertCurrentLaborRateContext: () => {},
  tekmetricSessionForContext: () => ({ token: "offline-provider-token" }),
  fetchLaborRateRules: async () => state.rules,
  laborRateContextKey: (context: any) =>
    `${context.provider}|${context.shopId}|${context.roId}|${context._tabId}`,
  laborRateBroadcastMetadata: () => ({
    contextDiscriminator: "offline-context",
    sessionDiscriminator: "offline-session",
  }),
  lastAppliedRoId: null,
  lastAppliedLaborRateContextKey: null,
  ownJobPostInFlight: false,
  chrome: {
    runtime: { sendMessage: () => Promise.resolve() },
    tabs: { sendMessage: () => Promise.resolve() },
  },
  tekmetricFetch: async (endpoint: string, init: any = {}) => {
    const method = init.method || "GET";
    if (/\/repair-order\/\d+$/.test(endpoint)) {
      return response(state.ro);
    }
    if (/\/repair-order\/\d+\/estimate$/.test(endpoint)) {
      return response({ data: { jobs: state.jobs } });
    }
    if (endpoint.includes("/jobs?repairOrderId=")) {
      return response({ content: state.jobs });
    }
    if (/\/repair-order\/\d+\/summary$/.test(endpoint)) {
      state.writes.push({ endpoint, method });
      return response({ message: "Repair Order updated" });
    }
    if (/\/api\/shop\/\d+\/job$/.test(endpoint) && method === "POST") {
      const payload = JSON.parse(init.body);
      const write = {
        endpoint,
        method,
        jobId: payload.id,
        name: payload.name,
        rates: (payload.labor || []).map((labor: any) => labor.rate),
      };
      state.writes.push(write);
      if (state.failedJobIds.has(payload.id)) {
        return response(
          { error: `Provider denied ${payload.name}`, code: "SHOP_FORBIDDEN" },
          { ok: false, status: 403 },
        );
      }
      return response({ ok: true });
    }
    throw new Error(`Unexpected offline request: ${method} ${endpoint}`);
  },
};

vm.createContext(sandbox);
vm.runInContext(
  `${core}
${matching}
${autoApply}
${perJob}
${roDefault}
this.__autoApply = autoApplyLaborRate;
this.__applyPerJob = applyLaborRatePerJob;
this.__applyToRO = applyLaborRateToRO;`,
  sandbox,
);

const context = {
  provider: "tekmetric",
  shopId: 14245,
  roId: 9001,
  roNumber: "RO-9001",
  _tabId: 17,
};

function job(id: number, name: string, category: string, rate = 10000): Job {
  return {
    id,
    name,
    jobCategoryName: category,
    labor: [{ id: id * 10, name: `${name} labor`, rate }],
  };
}

function categoryRule(
  name: string,
  rate: number,
  category: string,
  consent: unknown,
  priority = 10,
): Rule {
  return {
    id: name,
    name,
    rate,
    priority,
    conditions: [{ type: "jobCategory", values: [category] }],
    matchMode: "all",
    repriceExistingCategoryLabor: consent,
  };
}

function roRule(
  consent: unknown,
  overrideCategoryRates = false,
  rate = 150,
): Rule {
  return {
    id: "ro-default",
    name: "RO default",
    rate,
    priority: 1,
    conditions: [],
    matchMode: "all",
    applyToAllLabor: consent,
    overrideCategoryRates,
  };
}

function reset(rules: Rule[], jobs: Job[], laborRate = 10000) {
  state.rules = rules;
  state.jobs = structuredClone(jobs);
  state.ro = {
    id: context.roId,
    laborRate,
    vehicle: { year: 2024, make: "Honda", model: "Civic" },
    customer: {},
    jobs: structuredClone(jobs),
  };
  state.writes = [];
  state.failedJobIds = new Set();
  sandbox.lastAppliedRoId = null;
  sandbox.lastAppliedLaborRateContextKey = null;
}

function jobWrites() {
  return state.writes.filter(write => write.endpoint.endsWith("/job"));
}

function assertNoSummaryWrites(label: string) {
  assert.equal(
    state.writes.some(write => write.endpoint.includes("/summary")),
    false,
    `${label}: unverified provider cascade must never receive a summary PUT`,
  );
}

async function apply(manual: boolean) {
  return sandbox.__autoApply(context, manual ? { manual: true } : {});
}

async function verifyProtectedValues(manual: boolean) {
  for (const protectedValue of [undefined, false, "true", 1, null]) {
    reset(
      [categoryRule("Protected brakes", 180, "Brake", protectedValue)],
      [job(1, "Canned brake service", "Brake")],
    );
    await apply(manual);
    assert.deepEqual(
      jobWrites(),
      [],
      `category consent ${String(protectedValue)} must fail closed`,
    );

    reset(
      [roRule(protectedValue)],
      [job(1, "Custom uncategorized labor", "Custom")],
    );
    await apply(manual);
    assert.deepEqual(
      jobWrites(),
      [],
      `RO consent ${String(protectedValue)} must fail closed`,
    );
    assertNoSummaryWrites(`RO consent ${String(protectedValue)}`);
  }
}

async function run() {
  console.log("Task #1292: existing-job labor consent boundary");

  // Both entry paths enforce strict booleans; Apply Now is not extra consent.
  await verifyProtectedValues(false);
  await verifyProtectedValues(true);

  // Category-only consent is scoped. Canned/custom naming has no special
  // bypass, and unmatched existing jobs retain their original rates.
  for (const manual of [false, true]) {
    reset(
      [categoryRule("Brake category", 180, "Brake", true)],
      [
        job(1, "Canned brake service", "Brake"),
        job(2, "Custom brake diagnosis", "Brake"),
        job(3, "Unmatched alignment", "Alignment"),
      ],
    );
    await apply(manual);
    assert.deepEqual(
      jobWrites().map(write => [write.jobId, write.rates]),
      [[1, [18000]], [2, [18000]]],
      `${manual ? "manual" : "auto"} category consent must stay in scope`,
    );
    assertNoSummaryWrites("category-only consent");
  }

  // Highest-priority matching category owns the job even if protected.
  reset(
    [
      categoryRule("High protected", 200, "Brake", false, 100),
      categoryRule("Low consenting", 175, "Brake", true, 10),
      roRule(true),
    ],
    [job(1, "Brake overlap", "Brake"), job(2, "Alignment", "Alignment")],
  );
  await apply(false);
  assert.deepEqual(
    jobWrites().map(write => [write.jobId, write.rates]),
    [[2, [15000]]],
    "protected high-priority scope must not fall through to category or RO writes",
  );
  assertNoSummaryWrites("priority claim");

  reset(
    [
      categoryRule("High consenting", 200, "Brake", true, 100),
      categoryRule("Low consenting", 175, "Brake", true, 10),
    ],
    [job(1, "Brake overlap", "Brake")],
  );
  await apply(false);
  assert.deepEqual(
    jobWrites().map(write => [write.jobId, write.rates]),
    [[1, [20000]]],
    "highest-priority consenting category must be the only category write",
  );

  // Failed category writes remain claimed and never retry at the RO default.
  reset(
    [categoryRule("Brake category", 180, "Brake", true, 20), roRule(true)],
    [job(1, "Brake failure", "Brake"), job(2, "Unmatched custom", "Custom")],
  );
  state.failedJobIds.add(1);
  const partial = await apply(true);
  assert.deepEqual(
    jobWrites().map(write => [write.jobId, write.rates]),
    [[1, [18000]], [2, [15000]]],
  );
  assert.equal(
    jobWrites().filter(write => write.jobId === 1).length,
    1,
    "failed category job must not be retried with the RO rate",
  );
  assert.equal(partial.partialFailure, true);
  assertNoSummaryWrites("failed category claim");

  // Without override, consenting category jobs get their category rate and
  // only truly unmatched jobs may use separately-consented RO fallback.
  reset(
    [categoryRule("Brake category", 180, "Brake", true), roRule(true, false)],
    [job(1, "Brake", "Brake"), job(2, "Alignment", "Alignment")],
  );
  await apply(false);
  assert.deepEqual(
    jobWrites().map(write => [write.jobId, write.rates]),
    [[1, [18000]], [2, [15000]]],
  );

  // Override is precedence, not consent. It skips category writes; a category
  // job may fall back to the RO rate only when BOTH scopes explicitly consent.
  reset(
    [categoryRule("Brake protected", 180, "Brake", false), roRule(true, true)],
    [job(1, "Protected brake", "Brake"), job(2, "Alignment", "Alignment")],
  );
  await apply(false);
  assert.deepEqual(
    jobWrites().map(write => [write.jobId, write.rates]),
    [[2, [15000]]],
    "override cannot turn protected category scope into RO consent",
  );

  reset(
    [categoryRule("Brake consenting", 180, "Brake", true), roRule(true, true)],
    [job(1, "Consenting brake", "Brake"), job(2, "Alignment", "Alignment")],
  );
  await apply(false);
  assert.deepEqual(
    jobWrites().map(write => [write.jobId, write.rates]),
    [[1, [15000]], [2, [15000]]],
    "override may use RO fallback when category and RO both consent",
  );

  reset(
    [categoryRule("Brake consenting", 180, "Brake", true), roRule(false, true)],
    [job(1, "Consenting brake", "Brake")],
  );
  await apply(false);
  assert.deepEqual(jobWrites(), [], "override without RO consent must not write");

  // The direct sinks independently fail closed, preventing a future caller
  // from bypassing orchestration.
  reset([], [job(1, "Brake", "Brake")]);
  await sandbox.__applyPerJob(
    categoryRule("Direct protected", 180, "Brake", "true"),
    18000,
    { jobs: state.jobs },
    context,
    { manual: true },
  );
  assert.deepEqual(jobWrites(), []);
  await sandbox.__applyToRO(
    roRule(true),
    15000,
    { ...state.ro, laborRate: 10000 },
    context,
    { manual: true },
  );
  assertNoSummaryWrites("direct RO default sink");
  const noChange = await sandbox.__applyToRO(
    roRule(true),
    15000,
    { ...state.ro, laborRate: 15000 },
    context,
    { manual: true },
  );
  assert.equal(noChange.success, true);
  assert.equal(noChange.noChange, true);
  assertNoSummaryWrites("already-matching RO default");

  console.log("✓ auto and manual entry paths require strict explicit consent");
  console.log("✓ category scope, priority, failures, and overrides stay isolated");
  console.log("✓ unverified summary cascade fails closed at the direct sink");
  console.log("All labor-consent assertions passed.");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});