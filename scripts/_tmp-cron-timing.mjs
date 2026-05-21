import { MongoClient } from "mongodb";
const u = process.env.MONGODB_USERNAME, p = process.env.MONGODB_PASSWORD;
const uri = `mongodb+srv://${u}:${encodeURIComponent(p)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
const c = new MongoClient(uri);
await c.connect();
const db = c.db("mos-maintenance-mvp");

// How many open WOs at Protractor per "stale" shop right now (vs cached)?
// Use cached open count as a proxy for what cron would have to process.
const shopsOfInterest = [25, 29, 35, 50, 51, 66, 67, 68, 69, 70, 71, 72, 76, 116];
const INVOICED = ["Invoiced","Invoice","Void","Closed","Complete","Completed"];

for (const sid of shopsOfInterest) {
  const open = await db.collection("protractor_work_orders").countDocuments({
    shopId: { $in: [String(sid), sid] },
    $or: [{ workflowStage: { $nin: INVOICED } }, { workflowStage: null }, { workflowStage: "" }]
  });
  const total = await db.collection("protractor_work_orders").countDocuments({
    shopId: { $in: [String(sid), sid] }
  });
  const lastUpdate = await db.collection("protractor_work_orders")
    .find({ shopId: { $in: [String(sid), sid] } })
    .sort({ updatedAt: -1 }).limit(1).project({ updatedAt: 1, _id: 0 }).toArray();
  console.log(`shop ${String(sid).padEnd(4)} open=${String(open).padStart(4)} total=${String(total).padStart(5)} lastUpdate=${lastUpdate[0]?.updatedAt?.toISOString() || "never"}`);
}

// Look for any cron-locking doc to see when last full sweep ran
const locks = await db.collection("cron_locks").find({ name: /protractor-sync/i }).toArray();
console.log("\n=== cron_locks for protractor-sync ===");
console.log(JSON.stringify(locks, null, 2));

await c.close();
