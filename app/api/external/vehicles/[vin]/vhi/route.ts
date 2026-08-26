import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";
import { getCachedPlan } from "@/lib/plan-cache";
import { computeScore, getScoreTier, formatVhiItem, getVhiFromAnalysisCache, separateComplimentary, buildApiScore, buildItemDetail } from "@/lib/vhi-score";
import { getStatusIconSet, getServiceIconSet, getStatusIconSvg } from "@/lib/vhi-icons";
import { resolveServiceIconKey, getServiceIconUrl } from "@/lib/service-icons";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { rebuildVhi } from "@/lib/vhi-rebuild";
import { estimateMileageFromCarfax } from "@/lib/integrations/carfax";
import { getEnhancedVehicleData } from "@/lib/integrations/dataone-api";
import { buildMileageDiscrepancyFlag } from "@/lib/plan-build/mileage-discrepancy";
import { resolveOpenRoMileage, pickMileageInput, reconcileStaleActualWithEstimate, type MileageInputSource } from "@/lib/plan-build/open-ro-mileage";
import { getDb as getPgDb } from "@/lib/db/drizzle";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { withSlowCallLog } from "@/lib/log-slow-call";
import {
  buildPartnerVhiSuccessResponse,
  type PartnerVhiSuccessSource,
} from "@/lib/external-api/partner-vhi-response";

/**
 * Task #476: provenance label for the actual odometer reading the partner
 * endpoint fed into the plan engine. Distinct from `mileageSource`
 * (Task #384), which describes whether the value itself is actual vs
 * estimated — this field describes *where the actual reading came from*.
 * Contract is constrained to four values per the partner schema doc
 * (`docs/PARTNER_VHI_API.md`); the route-internal recovery paths
 * (expired cache / analysis cache) collapse to `"vehicles_collection"`
 * because they are all snapshot-derived from the same upstream.
 */

/**
 * Task #391: build the partner-facing `flags` array. Always present on
 * the response (empty when there are no flags) so partners can rely on
 * the shape. Currently only `mileage_discrepancy` is emitted.
 */
function buildFlags(opts: {
  mileageDiscrepancy?: {
    currentMiles: number;
    priorMiles: number;
    priorSource: string;
    priorDate: string | null;
    gapMiles: number;
  } | null;
  openRoMileageDiscrepancy?: {
    currentMiles: number;
    priorMiles: number;
    priorSource: string;
    priorDate: string | null;
    gapMiles: number;
  } | null;
}) {
  const flags: Array<ReturnType<typeof buildMileageDiscrepancyFlag>> = [];
  // Task #476: open-RO-vs-vehicles discrepancy fires whether or not the
  // plan-level CARFAX/shop-history discrepancy already fired — they
  // describe different evidence sources and the partner may want to act
  // on each separately. De-dup is by (priorSource, priorMiles).
  const pushed = new Set<string>();
  const consider = (d: typeof opts.mileageDiscrepancy) => {
    if (!d) return;
    const k = `${d.priorSource}|${d.priorMiles}`;
    if (pushed.has(k)) return;
    pushed.add(k);
    flags.push(buildMileageDiscrepancyFlag(d));
  };
  consider(opts.mileageDiscrepancy ?? null);
  consider(opts.openRoMileageDiscrepancy ?? null);
  return flags;
}

/**
 * Ensure every bucket item carries a non-null `iconSvg` and `serviceIconUrl`
 * for partners.
 *
 * The fresh-build paths pass `includeIconSvg: true` to `formatVhiItem`, but the
 * `analysis_cache` and `on_demand_build` branches serve buckets produced
 * elsewhere (cached snapshots / `rebuildVhi`) that may still have
 * `iconSvg: null` and predate the `serviceIconUrl` field. Partners (e.g.
 * AppFueled) read the per-item `iconSvg` and save the per-item `serviceIconUrl`,
 * so we backfill both here: `iconSvg` from `iconStatus`, and `serviceIconUrl`
 * from the item's `serviceIconKey` (or re-resolved from serviceKey/title).
 * Idempotent: items that already carry the fields are left untouched.
 */
function ensureItemIconSvg(buckets: any) {
  if (!buckets || typeof buckets !== "object") return buckets;
  const fill = (arr: any) =>
    Array.isArray(arr)
      ? arr.map((it) => {
          if (!it) return it;
          let next = it;
          if (it.iconSvg == null && it.iconStatus) {
            next = { ...next, iconSvg: getStatusIconSvg(it.iconStatus) };
          }
          if (it.serviceIconUrl == null) {
            const key = it.serviceIconKey || resolveServiceIconKey(it.serviceKey ?? null, it.title);
            next = { ...next, serviceIconUrl: getServiceIconUrl(key) };
          }
          // Task #730: backfill the partner-facing `detail` on cached/rebuilt
          // snapshots that predate the field so the analysis_cache branch never
          // leaves a DVI finding with only the raw status color to show.
          if (it.detail == null) {
            next = { ...next, detail: buildItemDetail(it) };
          }
          return next;
        })
      : arr;
  return {
    ...buckets,
    overdue: fill(buckets.overdue),
    dueSoon: fill(buckets.dueSoon),
    upcoming: fill(buckets.upcoming),
    complimentary: fill(buckets.complimentary),
  };
}

/**
 * Format a persisted plan document into the partner VHI response shape.
 * Shared by the cache-hit path and the rebuild-timeout "serve stale" path so
 * both branches return an identical contract. `source` distinguishes them.
 */
function buildPlanResponse(
  plan: any,
  opts: {
    vin: string;
    resolvedShopId: number | string;
    source: PartnerVhiSuccessSource;
    cachedAt: unknown;
    mileageInputSource: MileageInputSource | null;
    openRoMileageDiscrepancy: Parameters<typeof buildFlags>[0]["openRoMileageDiscrepancy"];
    /**
     * Task #943: freshly resolved anchor overlay. The anchor is resolved
     * BEFORE the cache lookup, so cache-hit / stale-plan responses must carry
     * today's mileage and basis instead of the value frozen into the older
     * cached plan (which may be a stale reading once presented as "Current").
     * The served plan/buckets are unchanged — only the headline mileage
     * fields are overlaid.
     */
    resolvedMiles?: number | null;
    resolvedMileageSource?: "actual" | "estimated_carfax" | "estimated_annual" | null;
    resolvedMileageEstimateDetails?: Record<string, unknown> | null;
  },
) {
  const separated = separateComplimentary(plan.buckets);
  const score = computeScore(separated);
  const hasOverlay = opts.resolvedMiles != null && opts.resolvedMiles > 0;
  const planSource: "actual" | "estimated_carfax" | "estimated_annual" =
    (hasOverlay ? opts.resolvedMileageSource : null) ?? plan.mileageSource ?? "actual";
  const planDetails = planSource === "actual"
    ? null
    : (hasOverlay ? opts.resolvedMileageEstimateDetails : null) ?? plan.mileageEstimateDetails ?? null;
  return buildPartnerVhiSuccessResponse({
    success: true,
    vin: opts.vin,
    vehicle: {
      year: plan.vehicle?.year ?? null,
      make: plan.vehicle?.make ?? null,
      model: plan.vehicle?.model ?? null,
      engine: plan.vehicle?.engine ?? null,
    },
    currentMiles: hasOverlay ? opts.resolvedMiles : plan.currentMiles,
    distanceUnit: plan.distanceUnit,
    customerName: plan.customerName ?? null,
    score: buildApiScore(score, plan.dataQuality),
    summary: {
      overdue: separated.overdue.length,
      dueSoon: separated.dueSoon.length,
      upcoming: separated.upcoming.length,
      complimentary: separated.complimentary.length,
    },
    buckets: {
      overdue: separated.overdue.map((it: any) =>
        formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "overdue", includeIconSvg: true })
      ),
      dueSoon: separated.dueSoon.map((it: any) =>
        formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "dueSoon", includeIconSvg: true })
      ),
      upcoming: separated.upcoming.map((it: any) =>
        formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "upcoming", includeIconSvg: true })
      ),
      complimentary: separated.complimentary.map((it: any) =>
        formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "complimentary", includeIconSvg: true })
      ),
    },
    icons: getStatusIconSet(),
    serviceIcons: getServiceIconSet(),
    cachedAt: opts.cachedAt,
    source: opts.source,
    mileageSource: planSource,
    mileageEstimated: planSource !== "actual",
    mileageEstimateDetails: planDetails,
    mileageInputSource: opts.mileageInputSource ?? "vehicles_collection",
    flags: buildFlags({
      mileageDiscrepancy: plan.mileageDiscrepancy ?? null,
      openRoMileageDiscrepancy: opts.openRoMileageDiscrepancy,
    }),
    dataQuality: plan.dataQuality ?? {
      sufficient: true,
      carfaxStatus: "ok",
      anchorCount: 0,
      carfaxRecordCount: 0,
      shopHistoryCount: 0,
      reasons: [],
    },
  }, opts.vin, opts.resolvedShopId);
}

// Decode model year from VIN position 10 (no DB required).
// VIN position 7 disambiguates 1980-2009 (digit) from 2010+ (letter).
const VIN_YEAR_LETTERS_PRE_2010: Record<string, number> = {
  A: 1980, B: 1981, C: 1982, D: 1983, E: 1984, F: 1985, G: 1986, H: 1987,
  J: 1988, K: 1989, L: 1990, M: 1991, N: 1992, P: 1993, R: 1994, S: 1995,
  T: 1996, V: 1997, W: 1998, X: 1999, Y: 2000,
  "1": 2001, "2": 2002, "3": 2003, "4": 2004, "5": 2005,
  "6": 2006, "7": 2007, "8": 2008, "9": 2009,
};
const VIN_YEAR_LETTERS_POST_2010: Record<string, number> = {
  A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015, G: 2016, H: 2017,
  J: 2018, K: 2019, L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025,
  T: 2026, V: 2027, W: 2028, X: 2029, Y: 2030,
};
function decodeYearFromVin(vin: string): number | null {
  if (!vin || vin.length < 10) return null;
  const v = vin.toUpperCase();
  const pos7 = v[6];
  const pos10 = v[9];
  const isPost2010 = /[A-Z]/.test(pos7);
  const map = isPost2010 ? VIN_YEAR_LETTERS_POST_2010 : VIN_YEAR_LETTERS_PRE_2010;
  return map[pos10] ?? null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createExternalEndpoint(
  "vehicles:read",
  async (req: NextRequest, { shopId, isPartner, partnerId, requestId }) => {
    const pathParts = req.nextUrl.pathname.split("/");
    const vinIndex = pathParts.indexOf("vehicles") + 1;
    const vin = pathParts[vinIndex]?.toUpperCase();
    const requestedMode = req.nextUrl.searchParams.get("mode");
    if (requestedMode && requestedMode !== "fast" && requestedMode !== "full") {
      return NextResponse.json(
        { error: 'mode must be either "fast" or "full"' },
        { status: 400 },
      );
    }
    const fastMode = requestedMode === "fast";

    if (!vin || vin.length !== 17) {
      return NextResponse.json(
        { error: "Valid 17-character VIN required" },
        { status: 400 }
      );
    }

    console.log(
      `[PartnerVHI] request_in requestId=${requestId} partnerId=${partnerId ?? "n/a"} ` +
      `isPartner=${isPartner} apiKeyShopId=${shopId} vin=${vin} mode=${fastMode ? "fast" : "full"}`
    );

    let resolvedShopId = shopId;

    if (isPartner) {
      const smsShopIdParam = req.nextUrl.searchParams.get("smsShopId");
      const smsParam = req.nextUrl.searchParams.get("sms");
      const shopIdParam = req.nextUrl.searchParams.get("shopId");

      if (shopIdParam) {
        const parsed = Number(shopIdParam);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return NextResponse.json(
            { error: "shopId must be a valid positive number" },
            { status: 400 }
          );
        }
        resolvedShopId = parsed;
      } else if (smsShopIdParam) {
        if (!smsParam) {
          return NextResponse.json(
            {
              error: "sms parameter required when using smsShopId",
              message: "Add &sms=tekmetric (or shopware, protractor, autoflow) to specify the SMS type",
            },
            { status: 400 }
          );
        }
        const shopResult = await findShopBySmsId(smsShopIdParam, {
          isPlatformAdmin: true,
          providerHint: smsParam.toLowerCase(),
        });
        if (!shopResult) {
          return NextResponse.json(
            { error: `No shop found for ${smsParam} ID: ${smsShopIdParam}` },
            { status: 404 }
          );
        }
        resolvedShopId = shopResult.mosShopId;
      } else {
        return NextResponse.json(
          {
            error: "Partner keys require shopId or smsShopId query parameter",
            message: "Add ?shopId=123 or ?smsShopId=456&sms=tekmetric to identify the shop",
          },
          { status: 400 }
        );
      }
    }

    const db = await getDb();

    // Shop records use numeric shopId, but other collections (vehicles in
    // particular) sometimes key by the shop's ObjectId, the ObjectId-as-string,
    // or the numeric/string shopId. Look up the shop once and build every
    // form so subsequent queries match regardless of how the data was keyed.
    const { ObjectId } = await import("mongodb");
    const shopRecord = await db.collection("shops").findOne(
      { shopId: { $in: [String(resolvedShopId), Number(resolvedShopId)] } },
      { projection: { _id: 1, integrationProvider: 1 } }
    );
    const shopIdVariants: any[] = [String(resolvedShopId), Number(resolvedShopId)];
    if (shopRecord?._id) {
      shopIdVariants.push(shopRecord._id);
      shopIdVariants.push(String(shopRecord._id));
      // also accept the _id parsed back from string (some writers store it as ObjectId-from-string)
      try {
        const oid = new ObjectId(String(shopRecord._id));
        if (!shopIdVariants.some((v) => v instanceof ObjectId && v.equals(oid))) {
          shopIdVariants.push(oid);
        }
      } catch {
        /* not a valid ObjectId, ignore */
      }
    }

    const vehicleDoc = await db.collection("vehicles").findOne(
      {
        shopId: { $in: shopIdVariants },
        vin: { $in: [vin, vin.toUpperCase()] },
      },
      { projection: { currentMileage: 1, lastMileage: 1, mileage: 1, odometer: 1, year: 1 } }
    );

    const vehicleDocMileage =
      vehicleDoc?.currentMileage ??
      vehicleDoc?.lastMileage ??
      vehicleDoc?.mileage ??
      vehicleDoc?.odometer ??
      null;

    // Task #476: prefer the most-recent RO's odometer over the
    // `vehicles.currentMileage` snapshot so the partner response matches
    // what the Detect Dog overlay shows. Selection logic lives in the
    // pure `pickMileageInput` helper so it can be regression-tested
    // without standing up Mongo + Postgres.
    let openRoLookup: Awaited<ReturnType<typeof resolveOpenRoMileage>> | null = null;
    try {
      // PG handle is lazy — only initialized for AutoFlow shops since
      // they're the only path that hits `normalized_work_orders`.
      const needsPg = (shopRecord?.integrationProvider ?? "").toLowerCase() === "autoflow";
      // Task #1119: slow-call log — a hang here happens BEFORE any
      // rebuild timeout and used to leave zero evidence in Better Stack.
      openRoLookup = await withSlowCallLog(
        resolveOpenRoMileage({
          db,
          pg: needsPg ? getPgDb() : undefined,
          shopIdVariants,
          vin,
          provider: shopRecord?.integrationProvider ?? null,
        }),
        "partner-vhi.resolveOpenRoMileage",
        5000,
        `requestId=${requestId} vin=${vin} shopId=${resolvedShopId}`,
      );
    } catch (err) {
      console.warn(
        `[PartnerVHI] open_ro_lookup_error requestId=${requestId} vin=${vin}:`,
        err instanceof Error ? err.message : err,
      );
    }
    // Task #476 + thrash fix: unify the mileage anchor with what the Detect
    // Dog overlay shows so the two surfaces don't build plans at different
    // mileages (which thrashes the shared plan cache — see memory
    // vhi-partner-latency). `pickMileageInput` is the AUTHORITATIVE selector for
    // the actual-data anchor: it prefers the open-RO odometer but applies the
    // monotonic guard — if the open RO reads LOWER than vehicles.currentMileage
    // (a stale/mistyped odometer) it keeps the larger vehicles value and emits a
    // discrepancy flag (Task #391/#476). Resolution order:
    //   (1) pickMileageInput → open-RO odometer, or vehicles.currentMileage when
    //       the open RO reads lower (monotonic guard)   [actual readings]
    //   (2) CARFAX estimate   [only when NO actual reading exists]
    //   (3) annual estimate   [year-based fallback, further below]
    // Resolved fully BEFORE getCachedPlan so the cache key matches the anchor
    // the extension uses.
    const picked = pickMileageInput({
      vehicleDocMileage: vehicleDocMileage ?? null,
      openRoLookup,
    });
    const openRoMileageDiscrepancy = picked.discrepancy;

    // (1) Authoritative actual-mileage anchor from the helper (open-RO with the
    // monotonic guard, else the vehicles snapshot).
    let mileage: number | null =
      picked.miles && picked.miles > 0 ? picked.miles : null;
    let mileageInputSource: MileageInputSource | null = mileage
      ? picked.mileageInputSource
      : null;
    let mileageSource: "actual" | "estimated_carfax" | "estimated_annual" = "actual";
    let mileageEstimateDetails: Record<string, unknown> | null = null;

    // (2) CARFAX estimate — when NO actual reading (neither open-RO nor the
    // vehicles snapshot) is available, OR (Task #872, amending Task #476's
    // "most-recent RO wins") when the winning RO odometer is older than
    // RO_ODOMETER_FRESHNESS_DAYS: a months-old posted-RO reading must not be
    // served as "Current", so we also compute the forward-projecting estimate
    // and take the LARGER of the two (monotonic guard — never go below a real
    // reading). `estimateMileageFromCarfax` is a cached Mongo read (no external
    // call), so it's cheap on the hot path; the timeout is a safety guard.
    if (!mileage || mileage <= 0 || picked.staleActual) {
      try {
        const est = await withUpstreamTimeout(
          estimateMileageFromCarfax(Number(resolvedShopId), vin),
          5000,
          `carfax estimateMileage ${vin}`,
          { estimated: false, mileage: null, reason: "timeout" } as any,
        );
        const estMiles = est.estimated && est.mileage && est.mileage > 0 ? est.mileage : null;
        const reconciled = reconcileStaleActualWithEstimate({
          actualMiles: picked.staleActual ? mileage : null,
          actualSource: mileageInputSource,
          estimateMiles: estMiles,
          // Task #943: when the estimate is unavailable/lower, project the
          // stale reading forward from its RO date at the default annual rate
          // so a months-old reading is never presented as "Current".
          staleReadingDate: picked.staleActual ? openRoLookup?.roDate ?? null : null,
        });
        if (reconciled.projectionWon && reconciled.miles) {
          mileage = reconciled.miles;
          mileageSource = "estimated_annual";
          mileageInputSource = "annual_estimated";
          mileageEstimateDetails = reconciled.projectionDetails;
          console.log(
            `[VHI External] Stale RO odometer projected forward for ${vin}: ` +
            `ro=${(reconciled.projectionDetails as any)?.baseMiles} → projected=${mileage} ` +
            `roDate=${(reconciled.projectionDetails as any)?.baseDate} (no usable CARFAX estimate)`
          );
        } else if (picked.staleActual && !reconciled.estimateWon) {
          // Stale RO still wins (estimate unavailable or lower, and no RO
          // date to project from) — keep the reading but log it.
          console.log(
            `[VHI External] Stale RO odometer retained for ${vin}: ro=${mileage} ` +
            `roDate=${openRoLookup?.roDate ? new Date(openRoLookup.roDate).toISOString() : "n/a"} estimate=${estMiles ?? "none"}`
          );
        } else if (reconciled.estimateWon && reconciled.miles) {
          mileage = reconciled.miles;
          mileageSource = "estimated_carfax";
          mileageInputSource = "carfax_estimated";
          mileageEstimateDetails = {
            confidence: est.confidence,
            dataPoints: est.dataPoints,
            lastRecordedMileage: est.lastRecordedMileage,
            lastRecordedDate: est.lastRecordedDate,
            milesPerDay: est.milesPerDay,
          };
        }
      } catch (err) {
        console.warn(`[VHI External] CARFAX estimate threw for ${vin}:`, err instanceof Error ? err.message : err);
      }
    }

    if (mileage) {
      console.log(
        `[VHI External] Resolved mileage ${mileage} for ${vin} (shop=${resolvedShopId}) source=${mileageInputSource}` +
        (openRoLookup ? ` openRo=${openRoLookup.miles}/${openRoLookup.integration}/${openRoLookup.roIdentifier ?? "n/a"}` : "") +
        ` vehiclesDoc=${vehicleDocMileage ?? "null"}`
      );
    }
    console.log(
      `[PartnerVHI] mileage_resolved requestId=${requestId} partnerId=${partnerId ?? "n/a"} ` +
      `shopId=${resolvedShopId} vin=${vin} mileage=${mileage ?? "null"} ` +
      `mileageInputSource=${mileageInputSource ?? "none"} ` +
      `openRoMiles=${openRoLookup?.miles ?? "null"} ` +
      `vehiclesDocMiles=${vehicleDocMileage ?? "null"}`
    );

    // Task #1119: slow-call log so a plan-cache read hang is visible.
    let cached = await withSlowCallLog(
      getCachedPlan(db, vin, resolvedShopId, mileage),
      "partner-vhi.getCachedPlan",
      5000,
      `requestId=${requestId} vin=${vin} shopId=${resolvedShopId}`,
    );

    if (cached) {
      const plan = cached.plan;
      const separated = separateComplimentary(plan.buckets);
      const score = computeScore(separated);
      const tier = getScoreTier(score);

      // Task #384: echo persisted mileage source. Legacy entries that
      // predate the persistence change are missing the fields — default
      // to "actual" / null so the response shape is always consistent.
      // Task #943: the anchor is resolved BEFORE this cache lookup, so a
      // cache hit must carry TODAY's freshly resolved mileage and basis —
      // not the value frozen into the older cached plan (which may be a
      // stale reading once presented as "Current"). The served plan/buckets
      // are unchanged; only the headline mileage fields are overlaid.
      const hasFreshAnchor = mileage != null && mileage > 0;
      const cachedSource: "actual" | "estimated_carfax" | "estimated_annual" =
        hasFreshAnchor ? mileageSource : plan.mileageSource ?? "actual";
      const cachedDetails =
        cachedSource === "actual"
          ? null
          : (hasFreshAnchor ? mileageEstimateDetails : null) ?? plan.mileageEstimateDetails ?? null;

      return NextResponse.json(buildPartnerVhiSuccessResponse({
        success: true,
        vin,
        vehicle: {
          year: plan.vehicle.year ?? null,
          make: plan.vehicle.make ?? null,
          model: plan.vehicle.model ?? null,
          engine: plan.vehicle.engine ?? null,
        },
        currentMiles: hasFreshAnchor ? mileage : plan.currentMiles,
        distanceUnit: plan.distanceUnit,
        customerName: plan.customerName ?? null,
        // Task #439: soften score in API when data-quality is
        // insufficient so partner integrations see the same gray
        // "Insufficient Data" representation as our UI. Raw value
        // preserved on `.computed`.
        score: buildApiScore(score, plan.dataQuality),
        summary: {
          overdue: separated.overdue.length,
          dueSoon: separated.dueSoon.length,
          upcoming: separated.upcoming.length,
          complimentary: separated.complimentary.length,
        },
        buckets: {
          overdue: separated.overdue.map((it) =>
            formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "overdue", includeIconSvg: true })
          ),
          dueSoon: separated.dueSoon.map((it) =>
            formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "dueSoon", includeIconSvg: true })
          ),
          upcoming: separated.upcoming.map((it) =>
            formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "upcoming", includeIconSvg: true })
          ),
          complimentary: separated.complimentary.map((it) =>
            formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "complimentary", includeIconSvg: true })
          ),
        },
        icons: getStatusIconSet(),
        serviceIcons: getServiceIconSet(),
        cachedAt: cached.createdAt,
        source: "cached_plan",
        mileageSource: cachedSource,
        mileageEstimated: cachedSource !== "actual",
        mileageEstimateDetails: cachedDetails,
        // Task #476: tell partners where the actual reading came from. On the
        // cached_plan branch we serve whatever the prior build was anchored
        // against; that prior build itself emitted `mileageInputSource` so
        // the cache row hit/miss decision is the right place to surface
        // today's resolution.
        mileageInputSource: mileageInputSource ?? "vehicles_collection",
        // Task #391: surface mileage rollback warning when present.
        flags: buildFlags({ mileageDiscrepancy: plan.mileageDiscrepancy ?? null, openRoMileageDiscrepancy }),
        // Task #439: data-quality signal so partner UIs can soften 0/CRITICAL.
        dataQuality: plan.dataQuality ?? { sufficient: true, carfaxStatus: "ok", anchorCount: 0, carfaxRecordCount: 0, shopHistoryCount: 0, reasons: [] },
      }, vin, resolvedShopId));
    }

    console.log(`[VHI External] No cached_plans entry for ${vin} at shop ${resolvedShopId}, checking analysis cache...`);
    // Task #1119: the analysis_cache branch had no slow-call logging — a
    // hang here left only request_in/mileage_resolved lines behind.
    const analysisResult = await withSlowCallLog(
      getVhiFromAnalysisCache(db, vin, resolvedShopId, mileage),
      "partner-vhi.getVhiFromAnalysisCache",
      5000,
      `requestId=${requestId} vin=${vin} shopId=${resolvedShopId}`,
    );

    if (analysisResult) {
      console.log(`[VHI External] Found analysis cache for ${vin} at shop ${resolvedShopId}`);
      // Task #384: spread defaults the source/details from the analysis
      // cache (handled by getVhiFromAnalysisCache for legacy entries).
      const aSource = analysisResult.mileageSource ?? "actual";
      const aDetails = aSource === "actual" ? null : analysisResult.mileageEstimateDetails ?? null;
      return NextResponse.json(buildPartnerVhiSuccessResponse({
        success: true,
        vin,
        ...analysisResult,
        // Backfill per-item iconSvg from iconStatus for partners (snapshot
        // buckets predate includeIconSvg). Overrides the spread `buckets`.
        buckets: ensureItemIconSvg((analysisResult as any).buckets),
        mileageSource: aSource,
        mileageEstimated: aSource !== "actual",
        mileageEstimateDetails: aDetails,
        // Task #476: same provenance field on the analysis-cache branch.
        mileageInputSource: mileageInputSource ?? "vehicles_collection",
        icons: getStatusIconSet(),
        serviceIcons: getServiceIconSet(),
        source: "analysis_cache",
        // Task #391: legacy analysis-cache rows generally have no flag,
        // but the array is always present for partner-shape stability.
        flags: buildFlags({ mileageDiscrepancy: analysisResult.mileageDiscrepancy, openRoMileageDiscrepancy }),
        // Task #439: analysis-cache predates the dataQuality signal —
        // default to "sufficient" so legacy entries keep showing their
        // score unchanged.
        dataQuality: { sufficient: true, carfaxStatus: "ok", anchorCount: 0, carfaxRecordCount: 0, shopHistoryCount: 0, reasons: [] },
      }, vin, resolvedShopId));
    }

    if (!mileage) {
      // Task #998: flag-dispatched PG/Mongo facade read (raw, incl. expired).
      const { findLatestCachedPlanDoc } = await import(
        "@/lib/data/repositories/plan-cache-store"
      );
      const expiredEntry = (await findLatestCachedPlanDoc(resolvedShopId, vin, db)) as any;
      if (expiredEntry) {
        mileage = expiredEntry.mileage || expiredEntry.plan?.currentMiles || null;
        // Task #476: expired-cache and analysis-cache recoveries are both
        // snapshot-derived from the same upstream that fills
        // vehicles.currentMileage, so they collapse to the same partner-
        // facing label rather than expanding the enum.
        if (mileage) mileageInputSource = "vehicles_collection";
        console.log(`[VHI External] Recovered mileage ${mileage} from expired cache for ${vin}`);
      }
    }

    if (!mileage) {
      // Task #998: flag-dispatched PG/Mongo facade read.
      const { getMaintenanceAnalysisDoc } = await import(
        "@/lib/data/repositories/plan-cache-store"
      );
      const analysisDoc = (await getMaintenanceAnalysisDoc(resolvedShopId, vin, db)) as any;
      if (analysisDoc?.mileageAtAnalysis) {
        mileage = analysisDoc.mileageAtAnalysis;
        mileageInputSource = "vehicles_collection";
        console.log(`[VHI External] Recovered mileage ${mileage} from analysis cache for ${vin}`);
      }
    }

    // Task #476: the open-RO lookup above is the primary path. The
    // per-provider work-order fallback that used to live here was
    // redundant once we hoisted the lookup before getCachedPlan — it
    // would only fire when the open-RO query already returned null, in
    // which case those same collections were just queried. Removed.

    // CARFAX estimate is now resolved up front (before getCachedPlan) in the
    // unified mileage block above, so the cache key matches the extension's
    // anchor. No second CARFAX attempt is needed here.

    // Fallback 2: model-year * 12k miles/year (US national average), so we never hard-fail.
    // Year source priority: vehicles doc → DataOne VIN decode → VIN position-10 character map.
    if (!mileage || mileage <= 0) {
      let year: number | null =
        vehicleDoc?.year && Number(vehicleDoc.year) > 1980 ? Number(vehicleDoc.year) : null;
      let yearSource = year ? "vehicles_doc" : null;

      if (!year) {
        try {
          // Task #1119: DataOne decode had no deadline or slow-call log —
          // a warming/hung DataOne endpoint was a true silent hang.
          const enhanced = await withSlowCallLog(
            getEnhancedVehicleData(vin),
            "partner-vhi.dataoneDecode",
            5000,
            `requestId=${requestId} vin=${vin}`,
          );
          const yr = enhanced?.vehicle?.year ? Number(enhanced.vehicle.year) : null;
          if (yr && yr > 1980) {
            year = yr;
            yearSource = "dataone_decode";
          }
        } catch (err) {
          console.warn(`[VHI External] DataOne decode threw for ${vin}:`, err instanceof Error ? err.message : err);
        }
      }

      if (!year) {
        const decoded = decodeYearFromVin(vin);
        if (decoded) {
          year = decoded;
          yearSource = "vin_position_10";
        }
      }

      if (year) {
        const age = Math.max(1, new Date().getFullYear() - year);
        const estimated = Math.min(250000, Math.max(12000, age * 12000));
        mileage = estimated;
        mileageSource = "estimated_annual";
        mileageInputSource = "annual_estimated";
        mileageEstimateDetails = {
          confidence: "very-low",
          method: "model_year_x_12k",
          modelYear: year,
          yearSource,
          assumedMilesPerYear: 12000,
        };
        console.log(
          `[VHI External] Estimated mileage ${mileage} from model year ${year} (source=${yearSource}) for ${vin} (12k/yr fallback)`
        );
      } else {
        console.warn(
          `[VHI External] Year-based fallback skipped for ${vin}: no year in vehicles doc, DataOne decode, or VIN position-10`
        );
      }
    }

    if (!mileage || mileage <= 0) {
      return NextResponse.json(
        {
          success: false,
          error: "Could not determine mileage for this vehicle",
          message: "No mileage found in vehicle records, cached plans, work orders, or CARFAX, and no model year available to estimate from.",
        },
        { status: 400 }
      );
    }

    console.log(
      `[PartnerVHI] rebuild_start requestId=${requestId} partnerId=${partnerId ?? "n/a"} ` +
      `shopId=${resolvedShopId} vin=${vin} mileage=${mileage} isPartner=${isPartner} ` +
      `mode=${fastMode ? "fast" : "full"}`
    );
    // Bound the cold build so a busy-shop stall can't hang the partner for
    // 1-2 min. The rebuild promise keeps running after the timeout fires and
    // still populates cached_plans, so a retry (or the Detect Dog overlay)
    // gets a cache hit. On timeout we serve the most-recent plan we already
    // have (even if expired) so AppFueled gets data now; only a never-before-
    // built VIN falls through to a 202 "building" response.
    const REBUILD_TIMEOUT_MS = 25000;
    const result = await withUpstreamTimeout(
      rebuildVhi(resolvedShopId, vin, mileage, {
        invalidateFirst: false,
        // Task #384: forward the resolved source so the persisted cache row
        // (and therefore the next cache HIT) carries the same fields.
        mileageSource,
        mileageEstimateDetails,
        // The plan-build route already supports fast mode; expose it to
        // partner callers without changing the default freshness-first path.
        fast: fastMode,
        // A shortened-budget plan must not poison the full-quality shared
        // cache. Fast callers get the inline result; normal requests continue
        // to read/write only full builds.
        persistBuiltPlan: !fastMode,
      }),
      REBUILD_TIMEOUT_MS,
      `partner rebuildVhi ${vin}`,
      null as unknown as Awaited<ReturnType<typeof rebuildVhi>>,
    );

    if (!result) {
      // Task #998: flag-dispatched PG/Mongo facade read (stale-serve branch).
      const { findLatestCachedPlanDoc: findLatestForStale } = await import(
        "@/lib/data/repositories/plan-cache-store"
      );
      const lastPlan = (await findLatestForStale(resolvedShopId, vin, db)) as any;
      if (lastPlan?.plan) {
        console.warn(
          `[PartnerVHI] rebuild_timeout_serving_stale requestId=${requestId} vin=${vin} ` +
          `shopId=${resolvedShopId} cachedAt=${lastPlan.createdAt}`
        );
        const staleResponse = buildPlanResponse(lastPlan.plan, {
            vin,
            resolvedShopId,
            source: "stale_plan_rebuilding",
            cachedAt: lastPlan.createdAt,
            mileageInputSource,
            openRoMileageDiscrepancy,
            // Task #943: carry today's freshly resolved anchor, not the
            // stale plan's frozen mileage.
            resolvedMiles: mileage,
            resolvedMileageSource: mileageSource,
            resolvedMileageEstimateDetails: mileageEstimateDetails,
          });
        return NextResponse.json({
          ...staleResponse,
          requestMode: fastMode ? "fast" : "full",
          buildMode: "stale",
          optionalDataMayBeIncomplete: true,
        });
      }
      console.warn(
        `[PartnerVHI] rebuild_timeout_no_cache requestId=${requestId} vin=${vin} shopId=${resolvedShopId}`
      );
      return NextResponse.json(
        {
          success: false,
          building: true,
          requestId,
          buildMode: fastMode ? "fast" : "full",
          message: "Maintenance plan is being built; please retry in a few seconds.",
        },
        { status: 202 },
      );
    }

    if (!result.success) {
      console.error(
        `[PartnerVHI] rebuild_failed requestId=${requestId} partnerId=${partnerId ?? "n/a"} ` +
        `shopId=${resolvedShopId} vin=${vin} mileage=${mileage} ` +
        `failedStage=${result.failedStage || "unknown"} upstreamStatus=${result.upstreamStatus ?? "n/a"} ` +
        `upstreamError=${typeof result.upstreamError === "string" ? result.upstreamError : JSON.stringify(result.upstreamError ?? null)}`
      );
      // missingMileage is a client-data issue (no odometer on the RO/vehicle),
      // not a server failure — surface as 400 so partners get an actionable
      // error instead of HTTP 500.
      const status = result.failedStage === "missingMileage" ? 400 : 500;
      return NextResponse.json(
        {
          success: false,
          error: result.error || "Failed to build maintenance plan",
          failedStage: result.failedStage,
          upstreamStatus: result.upstreamStatus,
          upstreamError: result.upstreamError,
          requestId,
          buildMode: fastMode ? "fast" : "full",
        },
        { status }
      );
    }

    return NextResponse.json(buildPartnerVhiSuccessResponse({
      success: true,
      vin,
      vehicle: result.vehicle,
      currentMiles: result.currentMiles,
      distanceUnit: result.distanceUnit,
      customerName: result.customerName,
      // Task #439: on-demand-build path — also soften the score when
      // the freshly built plan came back insufficient. `result.score`
      // is the raw computed shape from rebuildVhi; we rebuild it
      // through buildApiScore so partner consumers always see the
      // same softened representation.
      score: buildApiScore(
        typeof result.score?.value === "number" ? result.score.value : 0,
        result.dataQuality
      ),
      summary: result.summary,
      // Backfill per-item iconSvg for partners — rebuildVhi's formatVhiItem
      // calls don't pass includeIconSvg, so the items arrive with iconSvg null.
      buckets: ensureItemIconSvg(result.buckets),
      icons: getStatusIconSet(),
      serviceIcons: getServiceIconSet(),
      cachedAt: result.cachedAt,
      source: "on_demand_build",
      buildMode: fastMode ? "fast" : "full",
      optionalDataMayBeIncomplete: fastMode,
      // Task #384: prefer the rebuild result so the response matches the
      // values that were just persisted into cached_plans.
      mileageSource: result.mileageSource ?? mileageSource,
      mileageEstimated:
        (result.mileageSource ?? mileageSource) !== "actual",
      mileageEstimateDetails:
        (result.mileageSource ?? mileageSource) === "actual"
          ? null
          : result.mileageEstimateDetails ?? mileageEstimateDetails,
      // Task #476: forward the resolved mileage provenance on the
      // on-demand-build branch too so all three response branches
      // (cached_plan, analysis_cache, on_demand_build) carry the same
      // `mileageInputSource` shape AppFueled can read.
      mileageInputSource: mileageInputSource ?? "vehicles_collection",
      // Task #391: surface mileage rollback warning if the freshly built
      // plan recorded one. Always-present empty array otherwise.
      flags: buildFlags({ mileageDiscrepancy: result.mileageDiscrepancy ?? null, openRoMileageDiscrepancy }),
      // Task #439: data-quality on the on-demand-build path too, so all
      // three external response branches (cached_plan, analysis_cache,
      // on_demand_build) carry the same shape.
      dataQuality: result.dataQuality ?? { sufficient: true, carfaxStatus: "ok", anchorCount: 0, carfaxRecordCount: 0, shopHistoryCount: 0, reasons: [] },
    }, vin, resolvedShopId));
  }
);
