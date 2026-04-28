import { Db } from "mongodb";

const CACHE_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours
const MILEAGE_TOLERANCE = 500; // Plans are still valid within 500 miles

/**
 * Bump this whenever the cached plan shape changes incompatibly so old
 * cache entries are skipped on read instead of being served with missing
 * fields.
 *  - v2 (Apr 2026, task 163): adds `notes`, `action`,
 *    `recommendedDefault`, `recommendedReason`.
 *  - v3 (Apr 2026, task 166): adds engine-aware oil interval fields
 *    (`engineRiskFlag`, `engineRiskReason`, `intervalSchedule`,
 *    `intervalMilesNormal/Severe`, `intervalMonthsNormal/Severe`) plus
 *    plan-level `engineRisk` / `oilDutyPreference` and the
 *    auto-inserted Safety Check — oil level row.
 */
export const PLAN_CACHE_SCHEMA_VERSION = 3;

export interface DeclinedServiceCache {
  serviceKey: string;
  serviceName: string;
  mileage?: number | null;
  reason?: string | null;
  declinedAt: string;
}

export interface TriagedItemCache {
  key: string;
  serviceKey: string;
  title: string;
  category?: string;
  intervalMiles?: number | null;
  intervalMonths?: number | null;
  last?: { miles?: number | null; date?: string | null; source?: string };
  dueAtMiles?: number | null;
  dueAtDate?: string | null;
  milesToGo?: number | null;
  daysToGo?: number | null;
  bump?: "red" | "yellow" | null;
  source?: "oem" | "dvi" | "protractor" | "common";
  dviSource?: "autoflow" | "autovitals" | "tekmetric";
  reason?: string;
  usingShopInterval?: boolean;
  protractorDeferredId?: string;
  matchedDeferred?: { id: string; title: string };
  declined?: DeclinedServiceCache | null;
  /** Verb extracted from the source name ("inspect", "replace", ...). */
  action?: string | null;
  /** Free-text note carried from the OE row (e.g. "If equipped with dipstick"). */
  notes?: string | null;
  /**
   * True when this item is a shop / aiVHI default we generated because the
   * OE source had no actionable interval (e.g. "lifetime fluid").
   */
  recommendedDefault?: boolean;
  /** Human-readable rationale for the recommended-default override. */
  recommendedReason?: string | null;
  /* -------- Task #166: engine-aware oil interval fields -------- */
  /** True when the engine is flagged AND the active interval is risky. */
  engineRiskFlag?: boolean;
  /** Tooltip / chip rationale for engineRiskFlag. */
  engineRiskReason?: string | null;
  /** Which OEM duty schedule fed `intervalMiles` ("severe" | "normal"). */
  intervalSchedule?: "severe" | "normal" | null;
  /** OEM Normal-duty interval (mi/months), preserved alongside the active value. */
  intervalMilesNormal?: number | null;
  intervalMonthsNormal?: number | null;
  /** OEM Severe-duty interval (mi/months), preserved alongside the active value. */
  intervalMilesSevere?: number | null;
  intervalMonthsSevere?: number | null;
}

export interface CachedDeferredWork {
  ID?: string;
  ServiceItemID?: string;
  Title?: string;
  Description?: string;
}

export interface CachedPlanData {
  buckets: {
    overdue: TriagedItemCache[];
    dueSoon: TriagedItemCache[];
    upcoming: TriagedItemCache[];
  };
  vehicle: {
    year?: number | null;
    make?: string | null;
    model?: string | null;
    engine?: string | null;
    /** Task #166: engine profile fields used by the risk classifier. */
    engineSize?: number | null;
    engineCylinders?: number | null;
    engineInduction?: string | null;
    engineAspiration?: string | null;
  };
  currentMiles: number | null;
  mpdBlended: number | null;
  customerName: string | null;
  latestRoNumber: string | null;
  distanceUnit: "miles" | "kilometers";
  soonMiles: number;
  soonDays: number;
  showInspectItems: boolean;
  deferredWork?: CachedDeferredWork[];
  /** Task #166: classifier output and active duty preference. */
  engineRisk?: {
    flagged: boolean;
    reasons: string[];
    source: "baseline" | "override-flag" | "override-clear" | "none";
    matchedOverrideId?: string | null;
    matchedOverrideLabel?: string | null;
  };
  oilDutyPreference?: "normal" | "severe";
}

export interface CachedPlan {
  vin: string;
  shopId: number;
  mileage: number | null;
  plan: CachedPlanData;
  createdAt: Date;
  expiresAt: Date;
  schemaVersion?: number;
}

export async function getCachedPlan(
  db: Db, 
  vin: string, 
  shopId: number, 
  currentMiles?: number | null
): Promise<CachedPlan | null> {
  const candidates = await db.collection("cached_plans")
    .find({
      vin: vin.toUpperCase(),
      shopId: { $in: [String(shopId), Number(shopId)] },
    })
    .sort({ createdAt: -1 })
    .toArray() as CachedPlan[];

  if (candidates.length === 0) {
    console.log(`[PlanCache] MISS: No cache entry for ${vin}`);
    return null;
  }

  for (const entry of candidates) {
    if (entry.expiresAt <= new Date()) {
      const ageMinutes = Math.round((Date.now() - entry.expiresAt.getTime()) / 60000);
      console.log(`[PlanCache] SKIP: Expired ${ageMinutes}m ago for ${vin} (shopId=${entry.shopId})`);
      continue;
    }

    // Skip cache entries written under an older plan shape so the new fields
    // (notes, action, recommendedDefault, ...) reach the UI without waiting
    // for natural cache expiry.
    if ((entry.schemaVersion ?? 1) < PLAN_CACHE_SCHEMA_VERSION) {
      console.log(`[PlanCache] SKIP: stale schema v${entry.schemaVersion ?? 1} (current v${PLAN_CACHE_SCHEMA_VERSION}) for ${vin}`);
      continue;
    }

    if (currentMiles != null && currentMiles > 0) {
      if (entry.mileage == null || entry.mileage <= 0) {
        console.log(`[PlanCache] SKIP: Cache has no mileage but current is ${currentMiles} for ${vin}`);
        continue;
      }
      const mileageDiff = Math.abs(currentMiles - entry.mileage);
      if (mileageDiff > MILEAGE_TOLERANCE) {
        console.log(`[PlanCache] SKIP: Mileage changed ${entry.mileage} -> ${currentMiles} (diff: ${mileageDiff}) for ${vin}`);
        continue;
      }
    }

    const ageMinutes = Math.round((Date.now() - entry.createdAt.getTime()) / 60000);
    console.log(`[PlanCache] HIT: ${vin} cached ${ageMinutes}m ago, ${entry.mileage} miles`);
    return entry;
  }

  console.log(`[PlanCache] MISS: ${candidates.length} entries found but none valid for ${vin}`);
  return null;
}

export async function setCachedPlan(
  db: Db, 
  vin: string, 
  shopId: number, 
  mileage: number | null,
  plan: CachedPlanData
): Promise<void> {
  const now = new Date();
  const normalizedVin = vin.toUpperCase();
  const normalizedShopId = Number(shopId);

  await db.collection("cached_plans").deleteMany({
    vin: normalizedVin,
    shopId: { $in: [String(normalizedShopId), normalizedShopId] },
  });

  await db.collection("cached_plans").insertOne({
    vin: normalizedVin,
    shopId: normalizedShopId,
    mileage,
    plan,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
    schemaVersion: PLAN_CACHE_SCHEMA_VERSION,
  });
  console.log(`[PlanCache] Cached plan for ${vin} at ${mileage} miles, TTL 4h`);
}

export async function invalidateCachedPlan(db: Db, vin: string, shopId: number): Promise<void> {
  await db.collection("cached_plans").deleteMany({
    vin: vin.toUpperCase(),
    shopId: { $in: [String(shopId), Number(shopId)] },
  });
}

export async function checkAndTrackVin(
  db: Db, 
  shopId: number, 
  vin: string, 
  limit: number,
  roId?: string | null
): Promise<{ count: number; isNew: boolean; allowed: boolean }> {
  const normalizedVin = vin.toUpperCase();
  const normalizedRoNumber = roId?.trim() || null;
  
  // Track by VIN + RO combination - each visit counts as a new view
  // Use roNumber to match the existing MongoDB index (shopId_vin_roNumber)
  const query: any = { shopId, vin: normalizedVin, roNumber: normalizedRoNumber };
  
  const existing = await db.collection("viewed_vins").findOne(query);
  
  if (existing) {
    // Same VIN + RO already viewed - doesn't count again
    const count = await db.collection("viewed_vins").countDocuments({ shopId });
    await db.collection("viewed_vins").updateOne(
      query,
      { $set: { lastViewedAt: new Date() }, $inc: { viewCount: 1 } }
    );
    return { count, isNew: false, allowed: true };
  }
  
  // New VIN + RO combination - counts as a new view
  const count = await db.collection("viewed_vins").countDocuments({ shopId });
  
  if (count >= limit) {
    return { count, isNew: true, allowed: false };
  }
  
  const now = new Date();
  
  try {
    await db.collection("viewed_vins").insertOne({
      shopId,
      vin: normalizedVin,
      roNumber: normalizedRoNumber,
      firstViewedAt: now,
      lastViewedAt: now,
      viewCount: 1,
    });
    return { count: count + 1, isNew: true, allowed: true };
  } catch (err: any) {
    // Handle duplicate key error gracefully (race condition or null roNumber conflict)
    if (err.code === 11000) {
      // Already exists - just update and return as existing
      await db.collection("viewed_vins").updateOne(
        query,
        { $set: { lastViewedAt: now }, $inc: { viewCount: 1 } }
      );
      const updatedCount = await db.collection("viewed_vins").countDocuments({ shopId });
      return { count: updatedCount, isNew: false, allowed: true };
    }
    throw err;
  }
}

export async function trackViewedVin(db: Db, shopId: number, vin: string, roId?: string | null): Promise<{ count: number; isNew: boolean }> {
  const now = new Date();
  const normalizedVin = vin.toUpperCase();
  const normalizedRoNumber = roId?.trim() || null;
  
  // Use roNumber to match the existing MongoDB index (shopId_vin_roNumber)
  const query: any = { shopId, vin: normalizedVin, roNumber: normalizedRoNumber };
  
  try {
    const result = await db.collection("viewed_vins").updateOne(
      query,
      {
        $setOnInsert: {
          firstViewedAt: now,
        },
        $set: {
          lastViewedAt: now,
        },
        $inc: { viewCount: 1 },
      },
      { upsert: true }
    );
    
    const isNew = result.upsertedCount > 0;
    const count = await db.collection("viewed_vins").countDocuments({ shopId });
    
    return { count, isNew };
  } catch (err: any) {
    // Handle duplicate key error gracefully
    if (err.code === 11000) {
      await db.collection("viewed_vins").updateOne(
        query,
        { $set: { lastViewedAt: now }, $inc: { viewCount: 1 } }
      );
      const count = await db.collection("viewed_vins").countDocuments({ shopId });
      return { count, isNew: false };
    }
    throw err;
  }
}

export async function getViewedVinCount(db: Db, shopId: number): Promise<number> {
  return db.collection("viewed_vins").countDocuments({ shopId });
}

export async function hasViewedVin(db: Db, shopId: number, vin: string): Promise<boolean> {
  const doc = await db.collection("viewed_vins").findOne({ shopId, vin: vin.toUpperCase() });
  return doc !== null;
}
