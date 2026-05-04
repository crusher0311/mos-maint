// lib/shops.ts
//
// Wave 4 (#346) cutover: when IDENTITY_PG_CANONICAL=1, the canonical
// `shops` read goes to Postgres. Mongo remains the source of truth
// when the flag is unset, which is the safe default until the
// announced maintenance window runs the polarity flip. See
// `docs/runbooks/db-w4-cutover.md`.
import { getDb } from "./mongo";
import { isIdentityPgCanonical } from "./db/wave4-write-mode";
import { findShopByMosShopId } from "./data/repositories/pg/identity";

export async function getShopById(shopId: number) {
  if (isIdentityPgCanonical()) {
    return findShopByMosShopId(shopId);
  }
  const db = await getDb();
  return db.collection("shops").findOne({ shopId });
}
