import type { Db, Filter } from "mongodb";

/**
 * Build a type-tolerant filter for `shops.tekmetric.shopId`.
 *
 * Some shop records were written with `tekmetric.shopId` as a STRING (e.g.
 * "18009") and others as a NUMBER (e.g. 469). The webhook payload always
 * delivers `shopId` as a number. A naive `findOne({ "tekmetric.shopId": 18009 })`
 * silently misses string-typed shops, which leaves their cache rows without a
 * `shopId` field and makes their entire dashboard appear empty.
 *
 * See investigation notes in webhook handler.
 */
export function tekmetricShopIdFilter(tekmetricShopId: number | string): Filter<any> {
  const variants: (number | string)[] = [];
  const num = Number(tekmetricShopId);
  if (Number.isFinite(num)) variants.push(num);
  variants.push(String(tekmetricShopId));
  return { "tekmetric.shopId": { $in: variants } };
}

/**
 * Convenience wrapper: look up a shop by its Tekmetric shop ID, tolerating
 * both string and number storage of `tekmetric.shopId`.
 */
export async function findShopByTekmetricShopId(
  db: Db,
  tekmetricShopId: number | string,
  projection?: Record<string, 0 | 1>,
): Promise<any | null> {
  const filter = tekmetricShopIdFilter(tekmetricShopId);
  return db
    .collection("shops")
    .findOne(filter, projection ? { projection } : undefined);
}
