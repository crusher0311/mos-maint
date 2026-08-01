import { getDb } from "@/lib/mongo";
import { findVehicleByVin } from "@/lib/data/repositories/vehicles";
import { getCachedPlan, invalidateCachedPlan, type CachedPlan, type CachedPlanData } from "@/lib/plan-cache";
import { computeScore, getScoreTier, formatVhiItem, separateComplimentary } from "@/lib/vhi-score";

/**
 * Test seam: tests can override these to inject a fake DB / cached plan / build
 * trigger. Production callers go through the real implementations unchanged.
 */
export const __deps = {
  getDb,
  getCachedPlan,
  invalidateCachedPlan,
  triggerPlanBuild: (shopId: number, vin: string, mileage: number, fast?: boolean) =>
    triggerPlanBuild(shopId, vin, mileage, fast),
};

export type VhiRebuildFailedStage =
  | "triggerPlanBuild"
  | "cacheReadAfterBuild"
  | "missingMileage";

export interface PlanBuildTriggerResult {
  ok: boolean;
  status?: number;
  upstreamError?: any;
  errorMessage?: string;
  /** Set when plan-build returned 200 with `{ skipped: true }` (e.g. no mileage). */
  skipped?: boolean;
  skipReason?: string;
  /**
   * Task #613: the freshly-built plan returned inline by /api/plan-build so
   * the caller can skip the post-build sleep + cache re-read. Present only on
   * a successful build that actually constructed a plan (not the
   * "already cached" short-circuit). May be absent for legacy responses.
   */
  plan?: CachedPlanData;
  createdAt?: Date;
}

export interface VhiRebuildResult {
  success: boolean;
  vin: string;
  shopId: number;
  built: boolean;
  score?: {
    value: number;
    tier: string;
    color: string;
  };
  vehicle?: {
    year: number | null;
    make: string | null;
    model: string | null;
    engine: string | null;
  };
  currentMiles?: number | null;
  distanceUnit?: string;
  customerName?: string | null;
  summary?: {
    overdue: number;
    dueSoon: number;
    upcoming: number;
    complimentary?: number;
  };
  buckets?: {
    overdue: any[];
    dueSoon: any[];
    upcoming: any[];
    complimentary?: any[];
  };
  cachedAt?: Date;
  /** Task #384: source of the mileage that was used to build / read the plan. */
  mileageSource?: "actual" | "estimated_carfax" | "estimated_annual";
  /** Derived from mileageSource — true when source !== "actual". */
  mileageEstimated?: boolean;
  /** Task #384: structured details about the estimate (CARFAX projection, year×12k, ...). */
  mileageEstimateDetails?: Record<string, unknown> | null;
  /**
   * Task #391: mileage rollback warning persisted on the cached plan.
   * `null` (or absent) when no discrepancy was detected.
   */
  mileageDiscrepancy?: {
    currentMiles: number;
    priorMiles: number;
    priorSource: string;
    priorDate: string | null;
    gapMiles: number;
  } | null;
  /**
   * Task #439: customer-facing data-quality signal. When
   * `sufficient: false`, the UI should replace the numeric score with a
   * gray "Insufficient History" treatment. Legacy cached_plans rows
   * predate this field — callers should default to
   * `{ sufficient: true, carfaxStatus: "ok" }` if absent.
   */
  dataQuality?: {
    sufficient: boolean;
    carfaxStatus: "ok" | "no_history" | "vin_rejected" | "not_configured" | "error";
    anchorCount: number;
    carfaxRecordCount: number;
    shopHistoryCount: number;
    reasons: string[];
  };
  error?: string;
  failedStage?: VhiRebuildFailedStage;
  upstreamStatus?: number;
  upstreamError?: any;
}

function getInternalSecret(): string {
  return Buffer.from(process.env.DATABASE_URL || "").toString("base64").slice(0, 32);
}

export async function triggerPlanBuild(
  shopId: number,
  vin: string,
  mileage: number,
  fast?: boolean
): Promise<PlanBuildTriggerResult> {
  try {
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.RENDER_EXTERNAL_URL
        ? process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "")
        : `http://localhost:${process.env.PORT || 5000}`;

    const res = await fetch(
      `${baseUrl}/api/plan-build?vin=${encodeURIComponent(vin)}&mileage=${mileage}${fast ? "&fast=1" : ""}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": getInternalSecret(),
          "x-internal-shop-id": String(shopId),
        },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      let parsed: any = undefined;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      const message =
        (parsed && typeof parsed === "object" && (parsed.details || parsed.error || parsed.message)) ||
        (typeof parsed === "string" ? parsed : undefined) ||
        `HTTP ${res.status}`;
      console.error(
        `[VHI Rebuild] Plan build failed shopId=${shopId} vin=${vin} mileage=${mileage} status=${res.status}:`,
        typeof parsed === "string" ? parsed : JSON.stringify(parsed)
      );
      return {
        ok: false,
        status: res.status,
        upstreamError: parsed,
        errorMessage: typeof message === "string" ? message : String(message),
      };
    }

    // Task: plan-build returns 200 with { ok:true, skipped:true } when it
    // refuses to build (e.g. no mileage). Without inspecting the body we
    // would treat that as success, then fail later with the cryptic
    // "Plan build completed but cache not yet available" 500. Parse the
    // body and surface skipped responses distinctly so callers can return
    // a clean 4xx.
    try {
      const body = await res.json();
      if (body && body.skipped === true) {
        console.warn(
          `[VHI Rebuild] Plan build skipped shopId=${shopId} vin=${vin} mileage=${mileage} reason=${body.reason || "unspecified"}`
        );
        return {
          ok: false,
          status: res.status,
          skipped: true,
          skipReason: typeof body.reason === "string" ? body.reason : "skipped",
          upstreamError: body,
          errorMessage: typeof body.reason === "string" ? body.reason : "Plan build skipped",
        };
      }
      // Task #613: plan-build now returns the freshly-built plan inline so the
      // caller can avoid the post-build sleep + cache re-read. The "already
      // cached" short-circuit (`body.cached === true`) carries no plan — the
      // caller falls back to a re-read in that case.
      if (body && body.plan && typeof body.plan === "object") {
        return {
          ok: true,
          status: res.status,
          plan: body.plan as CachedPlanData,
          createdAt: body.createdAt ? new Date(body.createdAt) : new Date(),
        };
      }
    } catch {
      // Body wasn't JSON — treat as legacy success.
    }

    return { ok: true, status: res.status };
  } catch (err: any) {
    console.error(
      `[VHI Rebuild] Plan build trigger error shopId=${shopId} vin=${vin} mileage=${mileage}:`,
      err?.message
    );
    return {
      ok: false,
      upstreamError: { error: "fetch_failed", message: err?.message },
      errorMessage: err?.message || "Plan build trigger failed",
    };
  }
}

export async function rebuildVhi(
  shopId: number,
  vin: string,
  mileage: number,
  options: {
    invalidateFirst?: boolean;
    /**
     * Task #384: forwarded so the persisted `cached_plans` doc carries
     * the same source/details that the on-demand response reports. The
     * caller already resolved these (CARFAX projection, year×12k fallback,
     * or "actual"); we just plumb them through so a follow-up cache HIT
     * surfaces the identical fields.
     */
    mileageSource?: "actual" | "estimated_carfax" | "estimated_annual";
    mileageEstimateDetails?: Record<string, unknown> | null;
    /**
     * Task #613: latency-sensitive (interactive) build. Set by the extension
     * VHI button path so the underlying plan-build tightens every upstream
     * budget and prefers recent cached third-party data over blocking live
     * fetches. Defaults off so background / partner builds stay freshness-first.
     */
    fast?: boolean;
  } = {}
): Promise<VhiRebuildResult> {
  const tStart = Date.now();
  const db = await __deps.getDb();
  const vinUpper = vin.toUpperCase();

  // Defensive: callers are supposed to validate mileage, but if a 0 / NaN /
  // negative slips through it would hit /api/plan-build's `skipped: true`
  // path and return as a misleading 500 "cache not yet available". Surface
  // the real problem (no mileage) up front so partner routes can return 4xx.
  if (!Number.isFinite(mileage) || mileage <= 0) {
    console.warn(
      `[VHI Rebuild] Refusing to build with invalid mileage shopId=${shopId} vin=${vinUpper} mileage=${mileage}`
    );
    return {
      success: false,
      vin: vinUpper,
      shopId,
      built: false,
      error: "This vehicle has no mileage on the work order. Add an odometer reading and try again.",
      failedStage: "missingMileage",
    };
  }

  if (options.invalidateFirst) {
    await __deps.invalidateCachedPlan(db, vinUpper, shopId);
  }

  const tAfterInvalidate = Date.now();
  let cached = await __deps.getCachedPlan(db, vinUpper, shopId, mileage);
  const tAfterFirstRead = Date.now();

  if (!cached) {
    console.log(`[VHI Rebuild] No cached plan for ${vinUpper} at shop ${shopId}, triggering build${options.fast ? " (fast)" : ""}...`);
    const tBeforeBuild = Date.now();
    const built = await __deps.triggerPlanBuild(shopId, vinUpper, mileage, options.fast);
    const tAfterBuild = Date.now();
    console.log(`[VHI Rebuild] TIMING vin=${vinUpper} shop=${shopId} mileage=${mileage} fast=${!!options.fast} invalidate=${tAfterInvalidate - tStart}ms firstRead=${tAfterFirstRead - tAfterInvalidate}ms triggerPlanBuild=${tAfterBuild - tBeforeBuild}ms buildOk=${built.ok}${built.ok ? "" : ` upstream=${built.status} err=${built.errorMessage}`}`);

    if (!built.ok) {
      // Distinguish "plan-build refused because there's no usable input
      // (e.g. mileage)" from a true upstream failure. The former is a
      // client-data issue and should surface as 4xx, not 5xx.
      if (built.skipped) {
        return {
          success: false,
          vin: vinUpper,
          shopId,
          built: false,
          error:
            built.skipReason === "No mileage"
              ? "This vehicle has no mileage on the work order. Add an odometer reading and try again."
              : `Plan build skipped: ${built.skipReason || "unknown reason"}`,
          failedStage: "missingMileage",
          upstreamStatus: built.status,
          upstreamError: built.upstreamError,
        };
      }
      return {
        success: false,
        vin: vinUpper,
        shopId,
        built: false,
        error: "Failed to build maintenance plan",
        failedStage: "triggerPlanBuild",
        upstreamStatus: built.status,
        upstreamError: built.upstreamError ?? built.errorMessage,
      };
    }

    // Task #613: plan-build now returns the freshly-built plan inline. When
    // present, use it directly — no 500ms sleep, no post-build DB re-read.
    // The shape matches getCachedPlan's `{ plan, createdAt }`. Only fall back
    // to a re-read when the build short-circuited as "already cached" (no plan
    // in the body) — and even then skip the fixed sleep, since plan-build
    // writes the cache before responding.
    if (built.plan) {
      cached = { plan: built.plan, createdAt: built.createdAt ?? new Date() } as CachedPlan;
      console.log(`[VHI Rebuild] TIMING vin=${vinUpper} shop=${shopId} planFromBuild=true totalRebuild=${Date.now() - tStart}ms`);
    } else {
      const tBeforeReread = Date.now();
      cached = await __deps.getCachedPlan(db, vinUpper, shopId, mileage);
      console.log(`[VHI Rebuild] TIMING vin=${vinUpper} shop=${shopId} postBuildRead=${Date.now() - tBeforeReread}ms cacheVisible=${!!cached} totalRebuild=${Date.now() - tStart}ms`);
    }

    if (!cached) {
      return {
        success: false,
        vin: vinUpper,
        shopId,
        built: true,
        error: "Plan build completed but cache not yet available",
        failedStage: "cacheReadAfterBuild",
        upstreamStatus: built.status,
      };
    }
  } else {
    console.log(`[VHI Rebuild] TIMING vin=${vinUpper} shop=${shopId} mileage=${mileage} outcome=ALREADY_FRESH invalidate=${tAfterInvalidate - tStart}ms read=${tAfterFirstRead - tAfterInvalidate}ms total=${Date.now() - tStart}ms`);
  }

  const plan = cached.plan;
  const separated = separateComplimentary(plan.buckets);
  const score = computeScore(separated);
  const tier = getScoreTier(score);

  // Task #384: persist mileageSource/Details onto the cached plan doc when
  // the caller resolved them, so a subsequent cache HIT echoes the same
  // values rather than dropping them. We patch in-place instead of writing
  // a fresh setCachedPlan because the build endpoint owns the rest of the
  // plan shape.
  const cachedHasSource = plan.mileageSource !== undefined;
  let resolvedSource: "actual" | "estimated_carfax" | "estimated_annual" =
    options.mileageSource ?? plan.mileageSource ?? "actual";
  let resolvedDetails: Record<string, unknown> | null =
    resolvedSource === "actual"
      ? null
      : (options.mileageEstimateDetails ??
          (plan.mileageEstimateDetails as Record<string, unknown> | undefined) ??
          null);

  // Persist when:
  //  - the caller resolved a source different from what's cached, OR
  //  - the cache row is missing the field entirely (legacy entry — backfill
  //    even with "actual" so support tooling sees the field), OR
  //  - source matches but the caller has details the cache doesn't.
  const sourceChanged =
    options.mileageSource !== undefined &&
    options.mileageSource !== (plan.mileageSource ?? "actual");
  const legacyBackfill = !cachedHasSource;
  const detailsBackfill =
    resolvedSource !== "actual" &&
    options.mileageEstimateDetails != null &&
    plan.mileageEstimateDetails == null;

  if (sourceChanged || legacyBackfill || detailsBackfill) {
    try {
      // Task #998: flag-dispatched PG/Mongo facade patch.
      const { patchCachedPlanFields } = await import(
        "@/lib/data/repositories/plan-cache-store"
      );
      await patchCachedPlanFields(
        shopId,
        vinUpper,
        {
          mileageSource: resolvedSource,
          mileageEstimateDetails: resolvedSource === "actual" ? null : resolvedDetails,
        },
        db,
      );
    } catch (err: any) {
      console.warn(
        `[VHI Rebuild] Failed to persist mileageSource for ${vinUpper}: ${err?.message}`,
      );
    }
  }

  if (resolvedSource === "actual") {
    resolvedDetails = null;
  }

  return {
    success: true,
    vin: vinUpper,
    shopId,
    built: !options.invalidateFirst ? false : true,
    score: {
      value: score,
      tier: tier.label,
      color: tier.color,
    },
    vehicle: {
      year: plan.vehicle.year ?? null,
      make: plan.vehicle.make ?? null,
      model: plan.vehicle.model ?? null,
      engine: plan.vehicle.engine ?? null,
    },
    currentMiles: plan.currentMiles,
    distanceUnit: plan.distanceUnit,
    customerName: plan.customerName ?? null,
    summary: {
      overdue: separated.overdue.length,
      dueSoon: separated.dueSoon.length,
      upcoming: separated.upcoming.length,
      complimentary: separated.complimentary.length,
    },
    buckets: {
      overdue: separated.overdue.map((it) =>
        formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "overdue" })
      ),
      dueSoon: separated.dueSoon.map((it) =>
        formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "dueSoon" })
      ),
      upcoming: separated.upcoming.map((it) =>
        formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "upcoming" })
      ),
      complimentary: separated.complimentary.map((it) =>
        formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "complimentary" })
      ),
    },
    cachedAt: cached.createdAt,
    mileageSource: resolvedSource,
    mileageEstimated: resolvedSource !== "actual",
    mileageEstimateDetails: resolvedDetails,
    // Task #391: surface persisted mileage rollback flag (or null).
    mileageDiscrepancy: plan.mileageDiscrepancy ?? null,
    // Task #439: forward the data-quality signal so downstream UI can
    // render the gray "Insufficient History" treatment when warranted.
    // Legacy entries without the field default to "looks fine" so
    // existing scoring keeps showing through unchanged.
    dataQuality: plan.dataQuality ?? {
      sufficient: true,
      carfaxStatus: "ok",
      anchorCount: 0,
      carfaxRecordCount: 0,
      shopHistoryCount: 0,
      reasons: [],
    },
  };
}

export async function resolveMileageFromRo(
  db: any,
  shopId: number,
  provider: string,
  vin: string,
  roNumber?: string | null
): Promise<number | null> {
  const vinUpper = vin.toUpperCase();

  if (provider === "tekmetric") {
    const query: any = {
      shopId: { $in: [String(shopId), Number(shopId)] },
      vin: vinUpper,
    };
    if (roNumber) {
      query.$or = [
        { workOrderNumber: roNumber },
        { workOrderNumber: Number(roNumber) },
        { workOrderId: roNumber },
      ];
    }
    const wo = await db
      .collection("tekmetric_work_orders")
      // Task #960: most tekmetric_work_orders mirror docs carry Tekmetric's
      // own field names (updatedDate/createdDate), not updatedAt/createdAt —
      // sync writers stamp only the *Date variants (+ fetchedAt), while
      // webhook/ro-context writers stamp updatedAt/createdAt. Sort on both so
      // "most recent" doesn't silently degrade to insertion order.
      .findOne(query, {
        sort: { updatedAt: -1, updatedDate: -1, createdAt: -1, createdDate: -1 },
        projection: { odometer: 1 },
      });
    return wo?.odometer ?? null;
  }

  if (provider === "shopware") {
    const query: any = {
      mosShopId: { $in: [String(shopId), Number(shopId)] },
      vin: vinUpper,
    };
    if (roNumber) {
      query.$or = [
        { number: roNumber },
        { number: Number(roNumber) },
        { roId: Number(roNumber) },
      ];
    }
    const ro = await db
      .collection("shopware_repair_orders")
      .findOne(query, { sort: { updatedAt: -1 }, projection: { odometer: 1, "raw.odometer": 1, "raw.odometer_out": 1 } });
    return ro?.raw?.odometer_out ?? ro?.raw?.odometer ?? ro?.odometer ?? null;
  }

  if (provider === "protractor") {
    const query: any = {
      shopId: { $in: [String(shopId), Number(shopId)] },
      vin: vinUpper,
    };
    if (roNumber) {
      query.workOrderNumber = roNumber;
    }
    const wo = await db
      .collection("protractor_work_orders")
      .findOne(query, {
        sort: { updatedAt: -1 },
        projection: { OutUsage: 1, InUsage: 1, Odometer: 1, "data.OutUsage": 1, "data.InUsage": 1, "data.Odometer": 1 },
      });
    return wo?.OutUsage ?? wo?.InUsage ?? wo?.Odometer ??
      wo?.data?.OutUsage ?? wo?.data?.InUsage ?? wo?.data?.Odometer ?? null;
  }

  const vehicleDoc = await findVehicleByVin(vinUpper, shopId);
  return vehicleDoc?.currentMileage ?? vehicleDoc?.lastMileage ?? null;
}
