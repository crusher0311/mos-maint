import { Db } from "mongodb";
import {
  findCachedPlanCandidates,
  upsertCachedPlanDoc,
  deleteCachedPlans,
  deleteMaintenanceAnalysisForShop,
} from "@/lib/data/repositories/plan-cache-store";

const CACHE_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours
// Task #737: plans built while the OEM/VIN-attribute lookup timed out are
// cached with a much shorter TTL and skipped on read (outside the just-built
// freshness window) so one slow DataOne moment can't poison a vehicle's plan
// for 4 hours. The short row still exists so the freshness override keeps
// working for partner "await build → read cache" flows.
const OEM_MISSING_TTL_MS = 1000 * 60 * 10; // 10 minutes
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
 *  - v6 (May 2026, task 391): adds optional `mileageDiscrepancy` field
 *    so the rollback warning surfaces from cache without re-running
 *    detection. Older entries (which never carried the field) just
 *    surface no flag, which is the safe default — bumping the version
 *    forces a fresh build so the flag actually appears.
 */
/**
 * v7 (task #434) — adds `lastSource` ("direct" | "implied") and the
 * implied parent display fields on `last`. Bumping forces a one-time
 * rebuild so cached rows surface the new "Anchored to <parent> on <date>"
 * label instead of falling back to the legacy "Last done at … " chrome.
 *
 * v8 (Jul 2026, task #808) — Tekmetric declined/unauthorized jobs are now
 * folded into triage: matched items carry `declined.origin === "tekmetric"`
 * (+ `roNumber`) and are forced into the overdue bucket; unmatched declined
 * jobs become their own `source: "declined"` overdue entries. Bumping forces
 * a rebuild so Tekmetric vehicles pick up the declined grouping.
 *
 * v9 (Jul 2026, task #803) — adds optional `plans` (multi-plan variants:
 * OE / Shop / one per enabled chemical provider) so the dashboard tab
 * switcher reads every variant from one cached row. Primary `buckets`
 * stays the Shop-resolved plan (extension/partner consumers unchanged).
 * Originally shipped as v8, renumbered to v9 on rebase because task #808
 * had already used v8 in production — bumping forces a rebuild so rows
 * cached under #808's v8 (which lack `plans`) pick up the tab variants.
 *
 * v10 (Jul 2026, task #868) — adds `lifetimeFluidDefault` so the UI can
 * distinguish genuine lifetime-fluid recommended defaults from other
 * `recommendedDefault` producers (the engine-risk Safety Check — Oil
 * Level row). Bumping forces a rebuild so cached rows carry the flag and
 * the Safety Check row stops rendering the lifetime-fluid badge text.
 *
 * v11 (Aug 2026, task #1118) — declined jobs now aggregate onto plan items
 * (`declinedCount` + most-recent `declined` provenance), a guarded
 * title-containment secondary match attaches declines the key mappers
 * missed, and triage collapses duplicate items sharing one canonical
 * service key (the shop-interval retitle twin "Coolant Service" +
 * "Replace engine coolant."). Bumping forces a rebuild so cached plans
 * stop serving duplicate pairs for up to the 4h TTL.
 */
export const PLAN_CACHE_SCHEMA_VERSION = 11;

export interface DeclinedServiceCache {
  serviceKey: string;
  serviceName: string;
  mileage?: number | null;
  reason?: string | null;
  declinedAt: string;
  /** Task #808: "tekmetric" = declined job from Tekmetric history; "shop"/missing = manual list. */
  origin?: "shop" | "tekmetric";
  /** Task #808: RO number the job was declined on (Tekmetric only). */
  roNumber?: number | null;
}

export interface TriagedItemCache {
  key: string;
  serviceKey: string;
  title: string;
  category?: string;
  intervalMiles?: number | null;
  intervalMonths?: number | null;
  last?: {
    miles?: number | null;
    date?: string | null;
    source?: string;
    /** Task #434: stable id of the parent service when `lastSource === "implied"`. */
    impliedFromParentKey?: string | null;
    /** Task #434: customer-facing parent label ("tire replacement"). */
    impliedFromParentName?: string | null;
  };
  /**
   * Task #434: anchor provenance — `"direct"` when a CARFAX / shop /
   * Protractor record matched the canonical service key, `"implied"`
   * when the anchor was inferred from a parent service via the
   * `IMPLIES_RESET` map. `null`/missing for items that have never been
   * performed.
   */
  lastSource?: "direct" | "implied" | null;
  dueAtMiles?: number | null;
  dueAtDate?: string | null;
  milesToGo?: number | null;
  daysToGo?: number | null;
  bump?: "red" | "yellow" | null;
  source?: "oem" | "dvi" | "protractor" | "common" | "declined";
  dviSource?: "autoflow" | "autovitals" | "tekmetric" | "autoserve1" | "mastertech";
  reason?: string;
  usingShopInterval?: boolean;
  protractorDeferredId?: string;
  matchedDeferred?: { id: string; title: string };
  declined?: DeclinedServiceCache | null;
  /**
   * Task #1118: number of declined jobs accumulated onto this item
   * (repeat declines across ROs). `declined` carries the most recent one.
   * Missing while `declined` is set means 1 (legacy rows).
   */
  declinedCount?: number | null;
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
   * Task #868: True ONLY when the interval was synthesized from the
   * lifetime-fluid default. Distinguishes genuine lifetime fluids from
   * other recommendedDefault rows (e.g. Safety Check — Oil Level) so
   * cached reads render the correct badge text.
   */
  lifetimeFluidDefault?: boolean;
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
  /**
   * Task #392: per-axis triage status, persisted so cached / partner reads
   * can render "Overdue by time" vs "Overdue by mileage" without
   * recomputing. Either field may be null when the axis has no data
   * (e.g. no time interval, or no current mileage). The combined
   * worst-of bucket assignment still lives in the surrounding bucket.
   */
  byMiles?: "overdue" | "soon" | "ok" | null;
  byTime?: "overdue" | "soon" | "ok" | null;
}

/**
 * Task #803: one plan variant (tab) in a multi-plan cached row.
 * - `oe`: pure factory schedule (no shop interval overrides applied)
 * - `shop`: shop-resolved plan — always identical to the row's primary
 *   `buckets` (duplicated here so tab readers don't special-case it)
 * - `provider`: one per enabled chemical provider (id = provider id)
 */
export interface CachedPlanVariant {
  id: string;
  kind: "oe" | "shop" | "provider";
  label: string;
  buckets: {
    overdue: TriagedItemCache[];
    dueSoon: TriagedItemCache[];
    upcoming: TriagedItemCache[];
  };
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
  /**
   * Task #803: multi-plan variants (OE / Shop / one per enabled chemical
   * provider) for the dashboard tab switcher. Present ONLY when the shop
   * has at least one enabled provider with intervals — otherwise the field
   * is omitted entirely and readers fall back to single-plan rendering.
   * The `shop` variant always mirrors the primary `buckets`.
   */
  plans?: CachedPlanVariant[];
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
  /**
   * Task #391: Mileage rollback warning. Populated when the current
   * odometer is lower than a prior shop-history or CARFAX reading by
   * more than the tolerance (50 mi). Worst (largest gap) prior reading
   * wins. `null`/missing means no discrepancy.
   */
  mileageDiscrepancy?: {
    currentMiles: number;
    priorMiles: number;
    priorSource: string;
    priorDate: string | null;
    gapMiles: number;
  } | null;
  /**
   * Task #439: data-quality signal so VHI surfaces can distinguish
   * "score is low because the car needs work" from "score is low because
   * we have no service history to anchor against".
   *
   * `sufficient: false` is the trigger to render the gray "Insufficient
   * History" treatment instead of the red Critical badge. The numeric
   * score is still computed and persisted normally for internal
   * tracking — only the customer-facing presentation changes.
   *
   * Rule: sufficient = (carfaxRecords + shopServiceHistory) >= 3.
   *
   * `carfaxStatus` records why CARFAX did or didn't contribute:
   *   "ok"             — call succeeded with records
   *   "no_history"     — call succeeded but returned zero records
   *   "vin_rejected"   — CARFAX 107 (invalid VIN)
   *   "not_configured" — shop has no CARFAX env / location id
   *   "error"          — any other CARFAX-side failure
   *
   * Legacy cached_plans rows that predate this field should be treated
   * by readers as `{ sufficient: true, carfaxStatus: "ok" }` — they
   * scored fine before so they don't need the softened UI.
   */
  dataQuality?: {
    sufficient: boolean;
    carfaxStatus: "ok" | "no_history" | "vin_rejected" | "not_configured" | "error";
    anchorCount: number;
    carfaxRecordCount: number;
    shopHistoryCount: number;
    reasons: string[];
  };
  /**
   * Task #737: true when this plan was built WITHOUT OEM data because the
   * DataOne/VIN-attribute lookup timed out or errored during the build.
   * Such plans are degraded (no vehicle attributes, no OEM items) and must
   * not be served as the long-lived cached truth: `setCachedPlan` stores
   * them with a short TTL and `getCachedPlan` skips them outside the
   * just-built freshness window so the next load retries the OEM fetch and
   * upgrades the cached plan in place. Missing/false = plan is complete.
   */
  oemMissing?: boolean;
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
  // Task #998: reads dispatch through the plan-cache store facade
  // (PG-canonical behind PLAN_CACHE_PG_CANONICAL, Mongo otherwise). The
  // validity rules below are store-independent — both arms return the
  // same Mongo-shaped candidate docs, newest-first.
  const candidates = (await findCachedPlanCandidates(
    shopId,
    vin,
    db,
  )) as unknown as CachedPlan[];

  if (candidates.length === 0) {
    console.log(`[PlanCache] MISS: No cache entry for ${vin}`);
    return null;
  }

  const selected = selectValidCachedPlan(candidates, { vin, currentMiles, distanceUnit });
  if (!selected) {
    console.log(`[PlanCache] MISS: ${candidates.length} entries found but none valid for ${vin}`);
  }
  return selected;
}

/**
 * Pure cache-validity selector (task #998) — applies the TTL / schema /
 * distance-unit / oemMissing / mileage-tolerance rules to candidate
 * docs (newest-first) and returns the first valid entry. Extracted so
 * the Mongo and PG read paths share EXACTLY the same semantics and the
 * rules are unit-testable without a live store.
 */
export function selectValidCachedPlan(
  candidates: CachedPlan[],
  opts: {
    vin: string;
    currentMiles?: number | null;
    distanceUnit?: "miles" | "kilometers";
  },
): CachedPlan | null {
  const { vin, currentMiles, distanceUnit } = opts;
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

    // Task #737: a plan built while the OEM lookup timed out has no vehicle
    // attributes / OEM items. Serve it only within the just-built freshness
    // window (so partner await-build→read-cache flows still work), otherwise
    // treat it as a MISS so the next load retries the OEM fetch and replaces
    // the degraded row with a complete one.
    if (entry.plan?.oemMissing === true) {
      const ageMs = Date.now() - entry.createdAt.getTime();
      if (ageMs >= 30_000) {
        console.log(`[PlanCache] SKIP: oemMissing plan (built without OEM data ${Math.round(ageMs / 1000)}s ago) for ${vin} — forcing rebuild to retry OEM fetch`);
        continue;
      }
      console.log(`[PlanCache] HIT (oemMissing, just-built ${ageMs}ms ago) for ${vin} — serving degraded plan within freshness window`);
    }

    if (currentMiles != null && currentMiles > 0) {
      // 2026-05-12: freshness override. A row created within the last
      // 30 seconds is the result of a just-finished plan-build (either
      // ours or a concurrent caller's). Accept it regardless of mileage
      // delta — whatever the most-recent build resolved is the truth,
      // and rejecting it would force the awaiting partner request to
      // surface "cacheReadAfterBuild" even though a perfectly good plan
      // is sitting in the cache. The upsert in setCachedPlan guarantees
      // we won't see a stale row from a previous TTL window here (the
      // row is always overwritten in place).
      const ageMs = Date.now() - entry.createdAt.getTime();
      const isFreshlyBuilt = ageMs < 30_000;

      if (!isFreshlyBuilt) {
        if (entry.mileage == null || entry.mileage <= 0) {
          console.log(`[PlanCache] SKIP: Cache has no mileage but current is ${currentMiles} for ${vin}`);
          continue;
        }
        const mileageDiff = Math.abs(currentMiles - entry.mileage);
        if (mileageDiff > MILEAGE_TOLERANCE) {
          console.log(`[PlanCache] SKIP: Mileage changed ${entry.mileage} -> ${currentMiles} (diff: ${mileageDiff}) for ${vin}`);
          continue;
        }
      } else if (entry.mileage != null && Math.abs(currentMiles - entry.mileage) > MILEAGE_TOLERANCE) {
        console.log(`[PlanCache] HIT (freshness override): ${vin} cached ${ageMs}ms ago at ${entry.mileage} mi, request was ${currentMiles} mi (diff > ${MILEAGE_TOLERANCE}) — accepting because just-built`);
      }
    }

    const ageMinutes = Math.round((Date.now() - entry.createdAt.getTime()) / 60000);
    console.log(`[PlanCache] HIT: ${vin} cached ${ageMinutes}m ago, ${entry.mileage} miles`);
    return entry;
  }

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

  // 2026-05-12 (Task #392 follow-up): historically this was
  // deleteMany({vin, shopId}) followed by insertOne(...). Two near-
  // simultaneous plan-builds for the same VIN (e.g. AppFueled firing
  // partner VHI lookups in pairs, or a webhook colliding with a partner
  // request) would race: writer A's deleteMany would wipe writer B's
  // freshly-inserted row, leaving a brief window where the row didn't
  // exist OR where the row's mileage differed by > MILEAGE_TOLERANCE
  // from what the awaiting reader expected — surfacing as
  // "Plan build completed but cache not yet available"
  // (failedStage=cacheReadAfterBuild) on the partner.
  //
  // Fix: clean up only the legacy String-shopId variant rows first
  // (cheap idempotent cleanup so old polluted shops converge over
  // time), then upsert the canonical Number-shopId row. The row is
  // never absent — concurrent writers race on the upsert, last-write-
  // wins, but readers always see SOMETHING and the freshness override
  // in getCachedPlan accepts a just-built row even if its mileage
  // differs from the reader's request. (The legacy String-shopId cleanup
  // now lives in the facade's Mongo arm — task #998.)

  // Task #737: OEM-less (degraded) plans get a short TTL so they can't
  // linger as stale truth; getCachedPlan additionally skips them outside
  // the 30s freshness window.
  const ttlMs = plan.oemMissing === true ? OEM_MISSING_TTL_MS : CACHE_TTL_MS;

  await upsertCachedPlanDoc(
    shopId,
    vin,
    {
      mileage,
      plan: plan as unknown as Record<string, unknown>,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      schemaVersion: PLAN_CACHE_SCHEMA_VERSION,
    },
    db,
  );
  console.log(
    `[PlanCache] Cached plan for ${vin} at ${mileage} miles, TTL ${plan.oemMissing === true ? "10m (oemMissing — degraded, will retry OEM on next load)" : "4h"}`,
  );
}

/**
 * Drops cached plan rows for (vin, shopId).
 *
 * Task #484: also fires a live-push broadcast so the Detect Dog overlay
 * re-fetches within a second. The optional `reason` lets callers tag the
 * broadcast with their own observability label (e.g. the Tekmetric
 * webhook route passes `"tekmetric_webhook"` so the dashboard can
 * attribute the refresh to the webhook, not the generic invalidate).
 * Defaults to `"plan_cache_invalidate"`. Fire-and-forget — the
 * broadcaster never throws and the in-process debounce coalesces bursts.
 */
export async function invalidateCachedPlan(
  db: Db,
  vin: string,
  shopId: number,
  reason: "plan_cache_invalidate" | "tekmetric_webhook" = "plan_cache_invalidate"
): Promise<void> {
  await deleteCachedPlans(shopId, vin, db);
  try {
    const { broadcastVhiUpdated } = await import("@/lib/realtime/broadcast-vhi");
    broadcastVhiUpdated({ vin, shopId, reason }).catch(() => {});
  } catch {
    // module load failed — non-fatal, polling fallback handles it
  }
}

/**
 * Drops ALL cached plan + analysis rows for a shop (every VIN).
 *
 * Used when a shop-level input that feeds every plan changes — e.g. a CARFAX
 * Location ID is entered for the first time. Plans built before CARFAX was
 * connected have no service-history anchors, so they must be discarded and
 * rebuilt fresh (with CARFAX) the next time each vehicle is viewed. shopId is
 * matched as BOTH String and Number because legacy rows stored it either way.
 */
export async function invalidateShopPlanCache(
  db: Db,
  shopId: number,
): Promise<{ cachedPlans: number; analysisCache: number }> {
  const planCount = await deleteCachedPlans(shopId, undefined, db);
  const analysisCount = await deleteMaintenanceAnalysisForShop(shopId, db);
  console.log(
    `[PlanCache] Invalidated shop ${shopId} plan cache: cached_plans=${planCount} maintenance_analysis_cache=${analysisCount}`,
  );
  return {
    cachedPlans: planCount,
    analysisCache: analysisCount,
  };
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
