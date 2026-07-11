// Read-only repository over the `cached_plans` collection (task #804).
//
// The write/read-with-validation lifecycle lives in lib/plan-cache.ts
// (callers there hold a Db handle). This repository only exposes the
// narrow bulk-read the protection-plan roster needs: the latest cached
// multi-plan variants for a set of VINs so at-risk status can be shown
// without rebuilding plans. Stale/expired/old-schema rows are skipped —
// the roster then reports "no recent plan" instead of guessing.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import type { CachedPlanVariant } from "@/lib/plan-cache";
import { PLAN_CACHE_SCHEMA_VERSION } from "@/lib/plan-cache";

const COLLECTION = "cached_plans";

interface CachedPlanRow extends Document {
  vin: string;
  shopId: number | string;
  createdAt: Date;
  expiresAt: Date;
  schemaVersion?: number;
  plan?: {
    plans?: CachedPlanVariant[];
    currentMiles?: number | null;
  };
}

async function collection(): Promise<Collection<CachedPlanRow>> {
  const db = await getDb();
  return db.collection<CachedPlanRow>(COLLECTION);
}

export interface CachedPlanVariantsForVin {
  vin: string;
  createdAt: Date;
  currentMiles: number | null;
  plans: CachedPlanVariant[];
}

/**
 * Latest still-valid cached plan variants per VIN for a shop. VINs with no
 * fresh (unexpired, current-schema) cached row are absent from the map.
 */
export async function findCachedPlanVariantsForVins(
  shopId: number,
  vins: string[],
): Promise<Map<string, CachedPlanVariantsForVin>> {
  const result = new Map<string, CachedPlanVariantsForVin>();
  if (vins.length === 0) return result;
  const normVins = Array.from(new Set(vins.map((v) => v.toUpperCase())));
  const col = await collection();
  const rows = await col
    .find(
      {
        shopId: { $in: [String(shopId), Number(shopId)] },
        vin: { $in: normVins },
        expiresAt: { $gt: new Date() },
      },
      {
        projection: {
          vin: 1,
          createdAt: 1,
          expiresAt: 1,
          schemaVersion: 1,
          "plan.plans": 1,
          "plan.currentMiles": 1,
        },
      },
    )
    .sort({ createdAt: -1 })
    .toArray();

  for (const row of rows) {
    if ((row.schemaVersion ?? 1) < PLAN_CACHE_SCHEMA_VERSION) continue;
    const vin = (row.vin || "").toUpperCase();
    if (!vin || result.has(vin)) continue; // newest-first — keep the latest
    const plans = Array.isArray(row.plan?.plans) ? row.plan!.plans! : [];
    if (plans.length === 0) continue;
    result.set(vin, {
      vin,
      createdAt: row.createdAt,
      currentMiles: row.plan?.currentMiles ?? null,
      plans,
    });
  }
  return result;
}
