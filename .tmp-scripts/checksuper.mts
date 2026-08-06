import { getDb } from "../lib/mongo";
const db = await getDb();
const u = await db.collection("users").find({ email: "brandoncrusha@gmail.com" }).project({ password: 0, passwordHash: 0 }).toArray();
console.log(JSON.stringify(u.map(x => ({ shopId: x.shopId, role: x.role, platformRole: x.platformRole, isPlatformAdmin: x.isPlatformAdmin, isSuperAdmin: x.isSuperAdmin, keys: Object.keys(x) })), null, 1));
process.exit(0);
