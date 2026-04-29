import { MongoClient } from "mongodb";

const u = `mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME)}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
const c = new MongoClient(u);
await c.connect();
const db = c.db("mos-maintenance-mvp");

const goalDate = new Date();
goalDate.setFullYear(goalDate.getFullYear() - 2);

const rows = await db.collection("tekmetric_backfill_progress").find({}).toArray();
const shops = await db.collection("shops").find({ tekmetricShopId: { $exists: true } }).toArray();
const nameById = Object.fromEntries(shops.map(s => [s.shopId, s.name || `shop ${s.shopId}`]));

const fmt = d => d ? new Date(d).toISOString().slice(0,10) : "—";
const monthsAgo = d => {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  return (ms / (30.44 * 24 * 3600 * 1000)).toFixed(1) + "mo";
};

const enriched = rows.map(r => {
  const cursor = r.currentChunkEnd ? new Date(r.currentChunkEnd) : null;
  const isComplete = !!(r.complete || r.completed);
  const monthsBack = cursor ? ((Date.now() - cursor.getTime()) / (30.44 * 24 * 3600 * 1000)) : null;
  const monthsToGoal = cursor ? ((cursor.getTime() - goalDate.getTime()) / (30.44 * 24 * 3600 * 1000)) : null;
  return { ...r, isComplete, cursor, monthsBack, monthsToGoal, name: nameById[r.shopId] || `shop ${r.shopId}` };
});

const complete = enriched.filter(e => e.isComplete);
const incomplete = enriched.filter(e => !e.isComplete);
incomplete.sort((a,b) => (b.monthsToGoal ?? 0) - (a.monthsToGoal ?? 0));

console.log(`\n=== Tekmetric backfill state @ ${new Date().toISOString()} ===`);
console.log(`Total Tekmetric shops with progress doc: ${rows.length}`);
console.log(`  Complete:   ${complete.length}`);
console.log(`  Incomplete: ${incomplete.length}\n`);

console.log("INCOMPLETE shops (sorted by months-from-goal, worst first):");
console.log("shop  cursor       monthsBack  monthsToGoal  jobs    lastRunAt           lastError");
for (const e of incomplete) {
  const err = e.lastError ? String(e.lastError).slice(0,40) : "—";
  const monthsToGoal = e.monthsToGoal != null ? e.monthsToGoal.toFixed(1).padStart(5) : "—";
  const monthsBack = e.monthsBack != null ? e.monthsBack.toFixed(1).padStart(5) : "—";
  console.log(`  ${String(e.shopId).padEnd(4)} ${fmt(e.cursor).padEnd(12)} ${monthsBack}mo      ${monthsToGoal}mo       ${String(e.totalJobsIndexed||0).padStart(6)}  ${fmt(e.lastRunAt).padEnd(12)}        ${err}`);
}

console.log("\nCOMPLETE shops:");
for (const e of complete) {
  console.log(`  ${String(e.shopId).padEnd(4)} ${e.name} (jobs=${e.totalJobsIndexed||0})`);
}

await c.close();
