import { getDb } from "../lib/mongo";
const db = await getDb();
const brandons = await db.collection("users").find(
  { email: { $regex: "brandon", $options: "i" } },
  { projection: { email: 1, shopId: 1, shopIds: 1, role: 1 } }
).toArray();
console.log("BRANDONS:", JSON.stringify(brandons.map(u => ({ e: u.email, shopId: u.shopId, role: u.role, shopIds: u.shopIds })), null, 0));
const heartUsers = await db.collection("users").find(
  { $or: [ { shopId: 122 }, { shopId: "122" }, { shopIds: "122" }, { shopIds: 122 } ] },
  { projection: { email: 1, shopId: 1, shopIds: 1, role: 1 } }
).toArray();
console.log("SHOP122_USERS:", JSON.stringify(heartUsers.map(u => ({ e: u.email, shopId: u.shopId, role: u.role, n: (u.shopIds||[]).length })), null, 0));
process.exit(0);
