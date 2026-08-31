import {
  __protractorCircuitBreakerTestHooks,
  recordProtractorResponse,
} from "../lib/data/repositories/protractor-circuit-breaker";
import type { OpsAlert } from "../lib/alerts/notify";

type Doc = Record<string, any> & { _id: string };

function matches(doc: Doc | undefined, filter: Record<string, any>): boolean {
  if (!doc) return false;
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((part: Record<string, any>) => matches(doc, part));
    const value = doc[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("$exists" in expected) return expected.$exists ? value !== undefined : value === undefined;
      if ("$gte" in expected) return value instanceof Date && value >= expected.$gte;
    }
    return value === expected;
  });
}

function applyUpdate(doc: Doc, update: Record<string, any>, inserted: boolean): void {
  if (inserted) Object.assign(doc, update.$setOnInsert || {});
  Object.assign(doc, update.$set || {});
  for (const [key, amount] of Object.entries(update.$inc || {})) {
    doc[key] = (doc[key] || 0) + amount;
  }
  for (const key of Object.keys(update.$unset || {})) delete doc[key];
}

function fakeDb() {
  const docs = new Map<string, Doc>();
  const collection = {
    async updateOne(filter: Record<string, any>, update: Record<string, any>, options: Record<string, any> = {}) {
      let doc = docs.get(filter._id);
      if (!doc && options.upsert) {
        doc = { _id: filter._id };
        docs.set(filter._id, doc);
        applyUpdate(doc, update, true);
        return { matchedCount: 0, upsertedCount: 1 };
      }
      if (matches(doc, filter)) applyUpdate(doc!, update, false);
      return { matchedCount: matches(doc, filter) ? 1 : 0, upsertedCount: 0 };
    },
    async findOneAndUpdate(filter: Record<string, any>, update: Record<string, any>, options: Record<string, any> = {}) {
      let doc = docs.get(filter._id);
      if (!doc && options.upsert) {
        doc = { _id: filter._id };
        docs.set(filter._id, doc);
        applyUpdate(doc, update, true);
        return { ...doc };
      }
      if (!matches(doc, filter)) return null;
      applyUpdate(doc!, update, false);
      return { ...doc! };
    },
    async countDocuments(filter: Record<string, any>) {
      return [...docs.values()].filter((doc) => matches(doc, filter)).length;
    },
  };
  return { collection: () => collection, docs };
}

let failed = 0;
function ok(name: string, condition: boolean, detail = "") {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const db = fakeDb();
  const alerts: OpsAlert[] = [];
  __protractorCircuitBreakerTestHooks.getDb = async () => db as any;
  __protractorCircuitBreakerTestHooks.alert = async (alert) => {
    alerts.push(alert);
    return { slack: "skipped", betterstack: "logged" };
  };

  const start = new Date("2026-08-31T12:00:00.000Z");
  await recordProtractorResponse("secret-connection-a", 401, 0, start);
  await recordProtractorResponse("secret-connection-a", 403, 0, new Date(start.getTime() + 1_000));

  ok("connection transition pages once while open", alerts.length === 1, `alerts=${alerts.length}`);
  ok("connection alert identifies authentication scope", alerts[0]?.fields?.scope === "connection" && alerts[0]?.fields?.responseClass === "authentication");
  ok("connection alert includes the five-minute cooldown", alerts[0]?.fields?.cooldownMs === 300_000);
  ok("alert never exposes the raw connection id", !JSON.stringify(alerts).includes("secret-connection-a"));

  await recordProtractorResponse("secret-connection-b", 401, 0, new Date(start.getTime() + 2_000));
  await recordProtractorResponse("secret-connection-c", 401, 0, new Date(start.getTime() + 3_000));
  const providerAlerts = alerts.filter((alert) => alert.fields?.scope === "provider");
  ok("correlated connection failures page provider transition once", providerAlerts.length === 1);
  ok("provider auth alert carries a privacy-safe fingerprint", typeof providerAlerts[0]?.fields?.connectionFingerprint === "string" && String(providerAlerts[0]?.fields?.connectionFingerprint).length === 32);

  await recordProtractorResponse("secret-connection-d", 401, 0, new Date(start.getTime() + 4_000));
  ok("provider remains deduplicated while open", alerts.filter((alert) => alert.fields?.scope === "provider").length === 1);

  db.docs.get(`connection:${alerts[0]?.fields?.connectionFingerprint}`)!.probeUntil =
    new Date(start.getTime() + 5_000);
  db.docs.get("provider")!.probeUntil = new Date(start.getTime() + 5_000);
  await recordProtractorResponse("secret-connection-a", 200, 0, new Date(start.getTime() + 5_000));
  await recordProtractorResponse("secret-connection-a", 401, 0, new Date(start.getTime() + 6_000));
  ok("successful recovery allows a later connection open to re-page", alerts.filter((alert) => alert.fields?.scope === "connection" && alert.fields?.connectionFingerprint === alerts[0]?.fields?.connectionFingerprint).length === 2);

  db.docs.get("provider")!.probeUntil = new Date(start.getTime() + 7_000);
  await recordProtractorResponse("transient-a", 200, 0, new Date(start.getTime() + 7_000));
  await recordProtractorResponse("transient-a", 503, 0, new Date(start.getTime() + 7_000));
  await recordProtractorResponse("transient-a", 503, 0, new Date(start.getTime() + 8_000));
  await recordProtractorResponse("transient-a", 503, 45_000, new Date(start.getTime() + 9_000));
  const transient = alerts.find((alert) => alert.fields?.responseClass === "server");
  ok("transient provider transition reports response class and Retry-After cooldown", transient?.fields?.scope === "provider" && transient?.fields?.cooldownMs === 45_000);

  if (failed) throw new Error(`${failed} breaker-alert check(s) failed`);
  console.log("\nAll Protractor circuit-breaker alert checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});