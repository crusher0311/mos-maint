import { MongoClient } from "mongodb";
import { writeFileSync } from "fs";
import postgres from "postgres";

const u = `mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME)}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
const c = new MongoClient(u);
await c.connect();
const db = c.db("mos-maintenance-mvp");
const now = Date.now();
const fmt = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) + "Z" : "—");

// Q2: tekmetric_api_usage + cron_runs
const since24h = new Date(now - 86_400_000);
const since7d = new Date(now - 7 * 86_400_000);

const apiUsage24h = await db.collection("tekmetric_api_usage").countDocuments({ timestamp: { $gte: since24h } });
const apiUsage7d = await db.collection("tekmetric_api_usage").countDocuments({ timestamp: { $gte: since7d } });
const api429_24h = await db.collection("tekmetric_api_usage").countDocuments({ timestamp: { $gte: since24h }, is429: true });
const api429_7d = await db.collection("tekmetric_api_usage").countDocuments({ timestamp: { $gte: since7d }, is429: true });

console.log("=== Q2: tekmetric_api_usage ===");
console.log(`last 24h: ${apiUsage24h} calls, ${api429_24h} 429s (${apiUsage24h ? ((api429_24h/apiUsage24h)*100).toFixed(1) : "n/a"}%)`);
console.log(`last  7d: ${apiUsage7d} calls, ${api429_7d} 429s (${apiUsage7d ? ((api429_7d/apiUsage7d)*100).toFixed(1) : "n/a"}%)`);

// per-day breakdown
const perDay = await db.collection("tekmetric_api_usage").aggregate([
  { $match: { timestamp: { $gte: since7d } } },
  { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, calls: { $sum: 1 }, errors: { $sum: { $cond: ["$is429", 1, 0] } } } },
  { $sort: { _id: -1 } },
]).toArray().catch(() => []);
console.log("Per day (last 7d):");
for (const d of perDay) console.log(`  ${d._id}: ${d.calls} calls, ${d.errors} 429s`);

// cron_runs
const cronNames = [
  "tekmetric-backfill", "weekend-backfill-boost", "monday-backfill-catchup-boost",
  "fullpage-backfill-tekmetric", "new-shop-backfill-fastpath", "tekmetric-incremental-sync",
];
const cronRuns = await db.collection("cron_runs")
  .find({ name: { $in: cronNames }, startedAt: { $gte: since7d } })
  .sort({ startedAt: -1 })
  .toArray()
  .catch((e) => { console.error("cron_runs err:", e.message); return []; });
console.log(`\n=== Q2: cron_runs (7d, total=${cronRuns.length}) ===`);
const byName = {};
for (const r of cronRuns) {
  byName[r.name] = byName[r.name] || { total: 0, success: 0, error: 0, lastStart: null, lastSuccess: null };
  byName[r.name].total++;
  if (r.success) byName[r.name].success++; else byName[r.name].error++;
  if (!byName[r.name].lastStart || new Date(r.startedAt) > new Date(byName[r.name].lastStart)) byName[r.name].lastStart = r.startedAt;
  if (r.success && (!byName[r.name].lastSuccess || new Date(r.startedAt) > new Date(byName[r.name].lastSuccess))) byName[r.name].lastSuccess = r.startedAt;
}
for (const [name, s] of Object.entries(byName)) {
  console.log(`  ${name.padEnd(36)} total=${String(s.total).padStart(4)} ok=${String(s.success).padStart(4)} err=${String(s.error).padStart(3)} lastStart=${fmt(s.lastStart)} lastOk=${fmt(s.lastSuccess)}`);
}

// Check existence of collection at all
const collNames = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => /cron|tekmetric_backf|api_usage/.test(n));
console.log("\nRelevant collection names:", collNames);

// Q1 follow-up — shops 138 and 144 (never started). Why?
const neverStartedIds = [138, 144];
for (const id of neverStartedIds) {
  const p = await db.collection("tekmetric_backfill_progress").findOne({ shopId: id });
  const s = await db.collection("shops").findOne({ shopId: id });
  console.log(`\nshop=${id} progress=${JSON.stringify({
    completed: p?.completed, lastRunAt: p?.lastRunAt, queuedAt: p?.queuedAt,
    fullPageMode: p?.fullPageMode, lastError: p?.lastError, createdAt: p?.createdAt,
    logicVersion: p?.logicVersion, inFlightUntil: p?.inFlightUntil, inFlightOwner: p?.inFlightOwner,
  })}`);
  console.log(`        shop name=${s?.name} tekId=${s?.tekmetric?.shopId || s?.tekmetricShopId} createdAt=${fmt(s?.createdAt)}`);
}

// Q5: full-page progress over time. Look at recent fullPageProgress fields for HEART shops 112, 123 - both have nextPage > totalPages = 0
for (const id of [82, 112, 122, 123, 118, 78, 88, 92]) {
  const p = await db.collection("tekmetric_backfill_progress").findOne({ shopId: id });
  console.log(`fullpage shop=${id}: nextPage=${p?.fullPageNextPage} totalPages=${p?.fullPageTotalPages} lastFP=${fmt(p?.lastFullPageRunAt)} queuedAt=${fmt(p?.fullPageQueuedAt)} inFlight=${fmt(p?.inFlightUntil)} owner=${p?.inFlightOwner} jobs=${p?.totalJobsIndexed} completed=${p?.completed}`);
}

// Q4: PG count divergence (Supabase prod)
console.log("\n=== Q4: Mongo↔PG count divergence ===");
const client = postgres(process.env.SUPABASE_PROD_DATABASE_URL, { ssl: "require", max: 1 });
const sample = [32, 37, 54, 82, 99, 118, 138, 36];
const divergence = [];
for (const id of sample) {
  const p = await db.collection("tekmetric_backfill_progress").findOne({ shopId: id });
  const mongoTotal = p?.totalJobsIndexed || 0;
  let pgWO = -1, pgSJ = -1;
  try {
    pgWO = Number((await client`SELECT count(*)::int AS n FROM normalized_work_orders WHERE shop_id = ${id}`)[0].n);
    pgSJ = Number((await client`SELECT count(*)::int AS n FROM normalized_service_jobs WHERE shop_id = ${id}`)[0].n);
  } catch (e) {
    console.error(`pg query failed for shop ${id}:`, e.message);
  }
  const mongoWO = await db.collection("normalized_work_orders").countDocuments({ shopId: id });
  const mongoSJ = await db.collection("normalized_service_jobs").countDocuments({ shopId: id });
  const ji = await db.collection("job_index").countDocuments({ shopId: id });
  divergence.push({ shopId: id, mongoProgress: mongoTotal, mongoWO, pgWO, mongoSJ, pgSJ, jobIndex: ji });
  console.log(`  shop=${String(id).padEnd(4)} progressTotal=${String(mongoTotal).padStart(7)} mongoWO=${String(mongoWO).padStart(7)} pgWO=${String(pgWO).padStart(7)} mongoSJ=${String(mongoSJ).padStart(7)} pgSJ=${String(pgSJ).padStart(7)} job_index=${String(ji).padStart(7)}`);
}
await client.end();


writeFileSync(
  ".local/tasks/diagnose-backfill-evidence/api-usage-and-cron-runs.json",
  JSON.stringify({ apiUsage24h, apiUsage7d, api429_24h, api429_7d, perDay, cronByName: byName, cronRunsRecent: cronRuns.slice(0, 30), relevantCollections: collNames }, null, 2),
);
writeFileSync(
  ".local/tasks/diagnose-backfill-evidence/count-divergence.json",
  JSON.stringify(divergence, null, 2),
);

await c.close();
