import { MongoClient } from "mongodb";
const u = `mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME)}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
const c = new MongoClient(u); await c.connect();
const db = c.db("mos-maintenance-mvp");
const colls = (await db.listCollections().toArray()).map(x=>x.name).sort();
console.log("backfill/progress collections:");
for (const n of colls) if (/backfill|progress|sync|catchup/i.test(n)) console.log(" ", n);

for (const n of ["protractor_backfill_progress","autoflow_backfill_progress","shopware_backfill_progress","shop_ware_backfill_progress"]) {
  if (!colls.includes(n)) continue;
  const total = await db.collection(n).countDocuments();
  const complete = await db.collection(n).countDocuments({ completed: true });
  const since24h = new Date(Date.now()-86400000);
  const ran24h = await db.collection(n).countDocuments({ lastRunAt: { $gte: since24h }});
  console.log(`\n${n}: total=${total} completed=${complete} ran24h=${ran24h}`);
  const sample = await db.collection(n).find({}).sort({lastRunAt:-1}).limit(3).project({shopId:1,completed:1,lastRunAt:1,consecutiveChunkErrors:1,fullPageMode:1}).toArray();
  for (const s of sample) console.log(" ", JSON.stringify(s));
}
await c.close();
