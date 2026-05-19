import { MongoClient } from "mongodb";
const u = `mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME)}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
const c = new MongoClient(u); await c.connect();
const db = c.db("mos-maintenance-mvp");

// Recent tekmetric_api_usage doc & total
const totalApi = await db.collection("tekmetric_api_usage").estimatedDocumentCount();
const lastApi = await db.collection("tekmetric_api_usage").find({}).sort({timestamp:-1}).limit(1).toArray();
console.log("tekmetric_api_usage total docs:", totalApi, "last:", lastApi[0]?.timestamp);

// Check api_usage_logs
const totalLogs = await db.collection("api_usage_logs").estimatedDocumentCount();
const sampleLog = await db.collection("api_usage_logs").find({}).sort({_id:-1}).limit(3).toArray();
console.log("api_usage_logs total:", totalLogs, "sample fields:", Object.keys(sampleLog[0]||{}));

// Check for tekmetric calls in api_usage_logs
const since24h = new Date(Date.now() - 86_400_000);
const tekIn24h = await db.collection("api_usage_logs").countDocuments({ service: "tekmetric", timestamp: { $gte: since24h } }).catch(()=>"err");
const anyIn24h = await db.collection("api_usage_logs").countDocuments({ timestamp: { $gte: since24h } }).catch(()=>"err");
console.log("api_usage_logs tekmetric 24h:", tekIn24h, "any 24h:", anyIn24h);

// Check shop 138/144 vs fastpath gate
const newShop = await db.collection("shops").find({ createdAt: { $gte: new Date(Date.now()-14*86400000) }, $or:[{"tekmetric.shopId":{$exists:true,$ne:null}},{tekmetricShopId:{$exists:true,$ne:null}}]}).project({shopId:1,name:1,createdAt:1,tekmetricBackfillComplete:1}).toArray();
console.log("Shops onboarded in last 14d (fastpath candidates):", newShop.map(s=>`${s.shopId}/${s.name}/${s.createdAt?.toISOString?.()?.slice(0,16)}`));

// Check cron_runs collection (maybe it exists with different filter)
const allColls = (await db.listCollections().toArray()).map(c=>c.name).sort();
console.log("All collections containing 'cron' or 'lease' or 'lock':", allColls.filter(n=>/cron|lease|lock|schedul/i.test(n)));

// Recent progress writes - did chunks actually run in last 24h?
const recentRuns = await db.collection("tekmetric_backfill_progress").countDocuments({ lastRunAt: { $gte: since24h } });
const recentRunsByHour = await db.collection("tekmetric_backfill_progress").aggregate([
  { $match: { lastRunAt: { $gte: since24h } } },
  { $group: { _id: { $dateToString: { format: "%Y-%m-%d %H:00", date: "$lastRunAt" }}, n:{$sum:1}}}, {$sort:{_id:-1}}]).toArray();
console.log("Shops with lastRunAt in 24h:", recentRuns, "by hour:", recentRunsByHour);

// Check tekmetric_drain_lock — global lease
const drainLock = await db.collection("tekmetric_drain_lock").findOne({_id:"global"});
console.log("drain lock:", drainLock);

await c.close();
