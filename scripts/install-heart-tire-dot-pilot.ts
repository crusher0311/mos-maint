/** Explicit approved reporting-only installation. Never changes invoice stores. */
import { MongoClient } from "mongodb";
import { PILOT_CONTROL, PILOT_RANGE } from "../lib/tire-dot-pilot";

async function main() {
  if (!process.argv.includes("--install")) throw Error("Explicit --install is required");
  const client = new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`,
    { maxPoolSize: 1, serverSelectionTimeoutMS: 10_000 });
  try {
  await client.connect();
  const db = client.db("mos-maintenance-mvp");
  const enterprise = await db.collection("enterprise_accounts").findOne(
    { name: "HEART Certified Auto Care" }, { projection: { _id: 1, shopIds: 1 }, maxTimeMS: 2000 });
  if (!enterprise?.shopIds?.length) throw Error("Current HEART membership missing");
  const runs = db.collection("tire_dot_report_runs");
  await runs.createIndex({ activeKey: 1 }, { name: "tire_active", unique: true, sparse: true });
  await runs.createIndex({ requestKey: 1, status: 1, heartbeatAt: -1 }, { name: "tire_reuse" });
  await runs.createIndex({ status: 1, queuedAt: 1, heartbeatAt: 1 }, { name: "tire_claim" });
  await db.collection("tire_dot_pilot_evidence").createIndex(
    { generation: 1, shopId: 1, key: 1 }, { name: "pilot_generation_shop_key", unique: true });
  await db.collection("tire_dot_pilot_evidence").createIndex(
    { generation: 1, shopId: 1, verified: 1, inMonth: 1 }, { name: "pilot_coverage" });
  await db.collection("tire_dot_pilot_generations").createIndex(
    { enterpriseId: 1, state: 1 }, { name: "pilot_builds" });
  await db.collection<any>("tire_dot_pilot_control").updateOne({ _id: PILOT_CONTROL }, {
    $setOnInsert: { enterpriseId: String(enterprise._id), enabled: true,
      status: "scheduled", nextAt: new Date(), ...PILOT_RANGE, installedAt: new Date(),
      captureUntil: new Date("2026-11-03T12:00:00Z"), requestsUsed: 0,
      approval: "Reporting-only HEART October pilot; no invoice or financial writes" },
  }, { upsert: true });
  console.log("Reporting-only HEART October pilot installed. No source invoice indexes or records changed.");
  } finally { await client.close(); }
}
main().then(() => process.exit(0)).catch(() => {
  console.error("Pilot setup failed; inspect reporting collection/index permissions. No feature activation assumed.");
  process.exit(1);
});
