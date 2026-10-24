import { isIdentityPgCanonical, shadowWriteMongoIdentity } from "./db/wave4-write-mode";
import { updateShopFields } from "./data/repositories/pg/identity";
export const __deps = { updateShopFields, shadowWriteMongoIdentity };

/** Canonical-first lifecycle updates. Null represents cleared optional fields in
 * PG's JSON records; Mongo retains its historical $unset representation. */
export async function writeShopBillingState(
  db: any, shopId: number | string,
  update: { $set?: Record<string, any>; $unset?: Record<string, any> },
) {
  const writeMongo = () => db.collection("shops").updateOne({ shopId }, update);
  if (!isIdentityPgCanonical()) return writeMongo();
  const fields = { ...update.$set };
  for (const key of Object.keys(update.$unset ?? {})) fields[key] = null;
  const result = await __deps.updateShopFields(shopId, fields);
  if (!result.matchedCount) throw new Error("Canonical shop missing");
  await __deps.shadowWriteMongoIdentity("shop billing lifecycle", writeMongo);
  return result;
}
