import { getDb } from "../lib/mongo";
const db = await getDb();
const shops = await db.collection("shops").find(
  { $or: [ { "tekmetric.shopId": 18009 }, { "tekmetric.shopId": "18009" }, { shopId: 18009 }, { shopId: "18009" } ] },
  { projection: { shopId: 1, name: 1, integrationProvider: 1, "tekmetric.shopId": 1, "tekmetric.configured": 1, "tekmetric.shopName": 1, enterpriseId: 1 } }
).toArray();
console.log("SHOPS:", JSON.stringify(shops, null, 1));
process.exit(0);
