// lib/shops.ts
import { getDb } from "./mongo";
export async function getShopById(shopId: number) {
  const db = await getDb();
  return db.collection("shops").findOne({ shopId });
}
