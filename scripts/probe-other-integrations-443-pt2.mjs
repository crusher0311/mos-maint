import { MongoClient } from "mongodb";
const u = `mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME)}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
const c = new MongoClient(u); await c.connect();
const db = c.db("mos-maintenance-mvp");

// Generic backfill_progress (likely protractor + others)
const bp = await db.collection("backfill_progress").find({}).project({shopId:1,integrationType:1,provider:1,completed:1,lastRunAt:1,fullPageMode:1,consecutiveChunkErrors:1}).toArray();
console.log(`backfill_progress total: ${bp.length}`);
const byProvider = {};
for (const r of bp) {
  const k = r.integrationType || r.provider || "unknown";
  if (!byProvider[k]) byProvider[k] = { total:0, completed:0, ran24h:0, errors:0, fullpage:0 };
  byProvider[k].total++;
  if (r.completed) byProvider[k].completed++;
  if (r.lastRunAt && new Date(r.lastRunAt) > new Date(Date.now()-86400000)) byProvider[k].ran24h++;
  if ((r.consecutiveChunkErrors||0) >= 3) byProvider[k].errors++;
  if (r.fullPageMode) byProvider[k].fullpage++;
}
console.log(JSON.stringify(byProvider, null, 2));
console.log("\nSample rows:");
for (const r of bp.slice(0,5)) console.log(" ", JSON.stringify(r));

// Shop-Ware deeper look
const sw = await db.collection("shopware_backfill_progress").find({}).toArray();
console.log("\nShop-Ware progress full docs:");
for (const r of sw) console.log(" ", JSON.stringify({shopId:r.shopId, completed:r.completed, lastRunAt:r.lastRunAt, queuedAt:r.queuedAt, consec:r.consecutiveChunkErrors, fullPage:r.fullPageMode, lastError:r.lastError}));

await c.close();
