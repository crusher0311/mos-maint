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
 *  - v4 (Apr 2026, task 198): adds `inspectOnly` / `inspectOnlyReason`
 *    so OEM "Inspect …" rows on known fluids surface with a distinct
 *    "OEM: Inspect every X mi" chip and bypass the showInspectItems
 *    filter.
 *  - v5 (May 2026, task 333): triage now stores every distance field
 *    (`intervalMiles`, `dueAtMiles`, `milesToGo`, `last.miles`) in the
 *    shop's local distance unit. Older cache entries mixed real miles
 *    (OEM intervals) with shop-unit anchors and need to be discarded so
 *    Kilometers-preference shops stop seeing 1.6× inflated values.
 */
export const PLAN_CACHE_SCHEMA_VERSION = 5;

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
  /**
   * Task #198: True when the OEM only schedules an "Inspect …" verb on a
   * known fluid (no matching Replace row). The plan UI / VHR render this
   * as an "OEM: Inspect every X mi" chip and the showInspectItems filter
   * skips items with this flag so the fluid is never silently hidden.
   */
  inspectOnly?: boolean;
  /** Tooltip / chip rationale for inspectOnly. */
  inspectOnlyReason?: string | null;
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
  /**
   * Task #384: persisted alongside the plan so external VHI responses can
   * echo the same `mileageSource` / `mileageEstimateDetails` regardless of
   * whether they're served from cache or freshly built. Legacy entries that
   * predate this change are missing the fields — readers should default to
   * `"actual"` / `null` and treat `mileageEstimated` as derived.
   */
  mileageSource?: "actual" | "estimated_carfax" | "estimated_annual";
  mileageEstimateDetails?: Record<string, unknown> | null;
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
  currentMiles?: number | null,
  // Task #333: when a shop flips between miles and kilometers, the cached
  // distance fields (now stored in shop unit) become wrong. Skip stale
  // cache entries whose distanceUnit no longer matches the shop preference.
  distanceUnit?: "miles" | "kilometers"
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

    if (distanceUnit && entry.plan?.distanceUnit && entry.plan.distanceUnit !== distanceUnit) {
      console.log(`[PlanCache] SKIP: distanceUnit changed ${entry.plan.distanceUnit} -> ${distanceUnit} for ${vin}`);
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

/**
 * Records a (shopId, vin, roNumber) view in `viewed_vins` and returns the
 * running total. Task #271: VINs are no longer a billing/quota dimension —
 * this function always returns `allowed: true` and the `limit` argument is
 * accepted for backward compatibility but ignored. The running total keeps
 * growing so admin views can display "VINs viewed: N".
 */
export async function checkAndTrackVin(
  db: Db,
  shopId: number,
  vin: string,
  _limit: number,
  roId?: string | null
): Promise<{ count: number; isNew: boolean; allowed: boolean }> {
  const { count, isNew } = await trackViewedVin(db, shopId, vin, roId);
  return { count, isNew, allowed: true };
}

export async function trackViewedVin(db: Db, shopId: number, vin: string, roId?: string | null): Promise<{ count: number; isNew: boolean }> {
  const now = new Date();
  const normalizedVin = vin.toUpperCase();
  const normalizedRoNumber = roId?.trim() || null;

  // Wave 1 (task #342): PG `viewed_vins` is the canonical counter — must
  // succeed. Mongo is a best-effort legacy mirror retained for soak.
  const { pgTrackViewedVin } = await import("@/lib/db/repositories/wave1");
  const result = await pgTrackViewedVin(shopId, normalizedVin, normalizedRoNumber);

  try {
    await db.collection("viewed_vins").updateOne(
      { shopId, vin: normalizedVin, roNumber: normalizedRoNumber },
      {
        $setOnInsert: { firstViewedAt: now },
        $set: { lastViewedAt: now },
        $inc: { viewCount: 1 },
      },
      { upsert: true },
    );
  } catch (err) {
    const code = (err as { code?: number } | null)?.code;
    if (code !== 11000) console.error("[viewed_vins] Mongo mirror failed (non-fatal):", err);
  }

  return result;
}

export async function getViewedVinCount(_db: Db, shopId: number): Promise<number> {
  const { pgGetViewedVinCount } = await import("@/lib/db/repositories/wave1");
  return pgGetViewedVinCount(shopId);
}

export async function hasViewedVin(_db: Db, shopId: number, vin: string): Promise<boolean> {
  const { pgHasViewedVin } = await import("@/lib/db/repositories/wave1");
  return pgHasViewedVin(shopId, vin);
}
