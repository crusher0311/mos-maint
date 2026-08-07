import { getDb } from "../lib/mongo";
const db = await getDb();
const n = await db.collection("shop_activity_profiles").countDocuments();
console.log("profiles:", n);
if (n) {
  const docs = await db.collection("shop_activity_profiles").find({}, { projection: { shopId:1, provider:1, timezone:1, confidence:1, primaryQuietWindow:1, computedAt:1 } }).limit(8).toArray();
  for (const d of docs) console.log(d.shopId, d.provider, d.timezone, "conf=" + d.confidence, JSON.stringify(d.primaryQuietWindow), d.computedAt);
}
process.exit(0);
