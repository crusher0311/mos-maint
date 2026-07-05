// Repository for the specs/schedule cache warmer (see
// app/api/cron/specs-warm/route.ts). Keeps the warmer's Mongo access behind
// the repository layer so the route itself never calls getDb() directly.
import { getDb } from "@/lib/data/db";

/**
 * Returns the distinct 17-char VINs viewed since `cutoff`, across all shops.
 * The `viewed_vins` collection is upserted on every vehicle view, so this is
 * the "what advisors actually open" recency signal used to scope warming.
 */
export async function getRecentlyViewedVins(cutoff: Date): Promise<string[]> {
  const db = await getDb();
  const rows = (await db
    .collection("viewed_vins")
    .find(
      { lastViewedAt: { $gte: cutoff }, vin: { $type: "string" } },
      { projection: { vin: 1, _id: 0 } },
    )
    .toArray()) as Array<{ vin?: string }>;

  const seen = new Set<string>();
  for (const r of rows) {
    const vin = String(r.vin || "").toUpperCase().trim();
    if (vin.length === 17) seen.add(vin);
  }
  return [...seen];
}

/**
 * Given a list of VIN squishes, returns the subset that already have a
 * non-expired `dataone_cache` entry — i.e. the squishes the warmer can skip.
 * Keeps the warmer idempotent so repeated nightly runs do near-zero work
 * once the fleet is warm.
 */
export async function getFreshDataOneSquishes(
  squishes: string[],
  now: Date,
): Promise<Set<string>> {
  const fresh = new Set<string>();
  if (squishes.length === 0) return fresh;
  const db = await getDb();
  const docs = (await db
    .collection("dataone_cache")
    .find(
      { squish: { $in: squishes }, expiresAt: { $gt: now } },
      { projection: { squish: 1, _id: 0 } },
    )
    .toArray()) as Array<{ squish?: string }>;
  for (const d of docs) if (d.squish) fresh.add(d.squish);
  return fresh;
}
