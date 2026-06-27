// Persistent VIN -> decoded-specs cache for the extension Specs tab.
//
// DataOne decodes are expensive and, under connection pressure, can be
// refused entirely (PG error 53300 "remaining connection slots are
// reserved for SUPERUSER"). A VIN's decoded specs are effectively static,
// so we cache the DataOne output keyed by the full 17-char VIN and serve
// repeat lookups from Mongo — avoiding a live DataOne hit (and the load it
// adds) for any vehicle we've already seen.
//
// Stored in Mongo (not PG) on purpose: PG is the saturated tier, and using
// the VIN as `_id` gives us a unique index for free (no createIndex).
//
// Cache rules (enforced by the caller):
//   - Only SUCCESSFUL, UNAMBIGUOUS decodes are written. We never cache a
//     "DB full" failure or an ambiguous decode (those need live hints).
//   - Entries carry a version + timestamp; a version bump or age past
//     MAX_AGE_MS forces a fresh decode so DataOne corrections flow through.
import { getDb } from "@/lib/mongo";

const COLLECTION = "dataone_specs_cache";
const CACHE_VERSION = 1;
const MAX_AGE_MS = 120 * 24 * 60 * 60 * 1000; // 120 days

export interface CachedSpecs {
  vehicleInfo: any;
  grouped: any;
  specsCount: number;
}

export async function readSpecsCache(vin: string): Promise<CachedSpecs | null> {
  try {
    const db = await getDb();
    const doc: any = await db.collection(COLLECTION).findOne({ _id: vin as any });
    if (!doc) return null;
    if (doc.version !== CACHE_VERSION) return null;
    const cachedAt = doc.cachedAt instanceof Date ? doc.cachedAt.getTime() : 0;
    if (!cachedAt || Date.now() - cachedAt > MAX_AGE_MS) return null;
    return {
      vehicleInfo: doc.vehicleInfo ?? null,
      grouped: doc.grouped ?? {},
      specsCount: typeof doc.specsCount === "number" ? doc.specsCount : 0,
    };
  } catch (err) {
    console.warn(`[Extension specs] cache read failed for ${vin}:`, err);
    return null;
  }
}

export async function writeSpecsCache(vin: string, payload: CachedSpecs): Promise<void> {
  try {
    const db = await getDb();
    await db.collection(COLLECTION).updateOne(
      { _id: vin as any },
      {
        $set: {
          vehicleInfo: payload.vehicleInfo ?? null,
          grouped: payload.grouped ?? {},
          specsCount: payload.specsCount ?? 0,
          version: CACHE_VERSION,
          cachedAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch (err) {
    console.warn(`[Extension specs] cache write failed for ${vin}:`, err);
  }
}
