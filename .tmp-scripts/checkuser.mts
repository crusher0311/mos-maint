import { getDb } from "../lib/mongo";
const db = await getDb();
const users = await db.collection("users").find(
  { email: { $regex: "brandon", $options: "i" } },
  { projection: { email: 1, shopId: 1, shopIds: 1, role: 1 } }
).toArray();
console.log(JSON.stringify(users, null, 1));
process.exit(0);
