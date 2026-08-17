import { getDb } from "../lib/mongo";
const db = await getDb();
const since = new Date(Date.now() - 60*60*1000);
const col = db.collection("extension_telemetry_events");
const rows = await col.aggregate([
  { $match: { createdAt: { $gte: since }, event: "api.slow_call" } },
  { $group: { _id: { $dateToString: { format: "%H:%M", date: "$createdAt" } }, n: { $sum: 1 }, avgMs: { $avg: "$data.durationMs" }, maxMs: { $max: "$data.durationMs" } } },
  { $sort: { _id: 1 } },
], { maxTimeMS: 15000 }).toArray().catch(e=>{console.log("agg err", e.message); return [];});
for (const r of rows) console.log(r._id, "n="+r.n, "avg="+Math.round(r.avgMs||0), "max="+Math.round(r.maxMs||0));
console.log("--- latest samples:");
const sample = await col.find({ createdAt: { $gte: since }, event: "api.slow_call" }).sort({ createdAt: -1 }).limit(10).toArray();
for (const s of sample) console.log(s.createdAt?.toISOString?.().slice(11,19), s.shopId, JSON.stringify(s.data).slice(0,140));
process.exit(0);
