import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getCachedPlan, setCachedPlan, type CachedPlanData, type CachedPlanVariant } from "@/lib/plan-cache";
import {
  getEnabledChemicalProviders,
  providerIntervalsToOverrides,
} from "@/lib/plan-build/chemical-providers";
import { toKeyFromFreeText, toKeyFromName } from "@/lib/service-keys";
import { isDeclinedJobIndexRow } from "@/lib/job-index";
import { resolveAutoflowConfig, fetchDviWithCache } from "@/lib/integrations/autoflow";
import { resolveCarfaxConfig, fetchCarfaxWithCache, fetchCarfaxStaleWhileRevalidate } from "@/lib/integrations/carfax";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import {
  classifyEngineRisk,
  loadEngineRiskOverrides,
  OIL_INTERVAL_RISK_THRESHOLD_MILES,
  SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES,
  SAFETY_CHECK_OIL_LEVEL_KEY,
  type EngineProfile,
  type EngineRiskOverride,
  type EngineRiskResult,
} from "@/lib/engine-risk";
import {
  resolveProtractorConfig,
  fetchVehicleWithCache as fetchProtractorVehicle,
  fetchDeferredWorkWithCache as fetchProtractorDeferredWork,
  type ProtractorDeferredWork,
} from "@/lib/integrations/protractor";
import {
  resolveAutoVitalsConfig,
  fetchAutoVitalsInspectionByVin,
} from "@/lib/integrations/autovitals";
import { getRepairOrderInspectionsWithXAuth } from "@/lib/integrations/tekmetric/client";
import {
  DEFAULT_SOON_MILES,
  DEFAULT_SOON_DAYS,
  parseCarfaxDate,
  triage,
  convertToCache,
  toOEMItem,
  type OEMItem,
  type TriagedItem,
  type DeclinedServiceEntry,
  type TekmetricDeclinedJob,
  type ShopIntervalOverride,
  type ShopServiceHistory,
} from "@/lib/plan-build/triage";
import { listTekmetricDeferredWorkByVin } from "@/lib/data/repositories/tekmetric-deferred-work";
import { resolveCustomerName } from "@/lib/plan-build/customer-name";
import { buildCarfaxMatchDiagnostics } from "@/lib/plan-build/carfax-match-diagnostic";
import { recordUnmatchedCarfaxDescription } from "@/lib/carfax-match-log";
import { isRemediedSinceInspection } from "@/lib/dvi-prefill-history";
import { gatherDviLinkFindings } from "@/lib/dvi-links/plan-findings";
import { getCarfaxOverridesMap } from "@/lib/carfax-overrides";
import {
  detectMileageDiscrepancy,
  shopHistoryLabelFromProvider,
} from "@/lib/plan-build/mileage-discrepancy";
import { resolveShopDistanceUnit, type ShopDistanceDoc } from "@/lib/shop-distance-unit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours
const PROTRACTOR_CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours
const DVI_CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  // Captured so the 500 catch (task #510) can stamp the shop on the
  // structured `[ShopErrorRate]` marker — declaring `shopId` only
  // inside the try block would leave the alert un-grouped per shop.
  let shopIdForError: number | null = null;

  try {
    let shopId: number;

    // Task #655: operator CARFAX match diagnostic. When `diag=carfax` and the
    // caller is a platform admin, the route returns a per-record breakdown of
    // how each CARFAX entry matched (or didn't) instead of building/caching a
    // plan. Gated below; ignored for everyone else so the hot path is unchanged.
    const diag = req.nextUrl.searchParams.get("diag");
    let isPlatformAdmin = false;

    const internalSecret = req.headers.get("x-internal-secret");
    const internalShopId = req.headers.get("x-internal-shop-id");
    if (
      internalSecret &&
      internalShopId &&
      process.env.DATABASE_URL &&
      internalSecret === Buffer.from(process.env.DATABASE_URL).toString("base64").slice(0, 32)
    ) {
      shopId = Number(internalShopId);
    } else {
      const session = await getSession();
      if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      shopId = Number(session.shopId);
      isPlatformAdmin = !!session.isPlatformAdmin;
      // Platform admins running the CARFAX diagnostic may target any shop's
      // vehicle via ?shopId=, since their own session shop is rarely the one
      // a support ticket is about.
      if (isPlatformAdmin && diag === "carfax") {
        const shopIdOverride = req.nextUrl.searchParams.get("shopId");
        if (shopIdOverride && Number.isFinite(Number(shopIdOverride))) {
          shopId = Number(shopIdOverride);
        }
      }
    }
    shopIdForError = shopId;

    if (diag === "carfax" && !isPlatformAdmin) {
      return NextResponse.json(
        { error: "Platform admin access required" },
        { status: 403 },
      );
    }
    const carfaxDiagMode = diag === "carfax" && isPlatformAdmin;

    const vin = req.nextUrl.searchParams.get("vin")?.toUpperCase();
    const mileageParam = req.nextUrl.searchParams.get("mileage");
    const mileage = mileageParam ? parseInt(mileageParam, 10) : null;
    // Task #613: the extension VHI button is latency-sensitive. When the
    // caller asks for the "fast" build, we tighten every upstream budget and
    // prefer recent cached third-party data over blocking live fetches so the
    // checkboxes appear in seconds instead of 45s+. Background/partner builds
    // (no flag) keep the original, freshness-first behavior.
    const fast = req.nextUrl.searchParams.get("fast") === "1";
    
    if (!vin || vin.length !== 17) {
      return NextResponse.json({ error: "Valid 17-character VIN required" }, { status: 400 });
    }
    
    if (!mileage || mileage <= 0) {
      return NextResponse.json({ ok: true, vin, skipped: true, reason: "No mileage" }, { status: 200 });
    }

    const db = await getDb();

    // Task #655 (manual edit): operator-defined CARFAX-description → service-key
    // overrides. Loaded once (cached in-process) and consulted live by both the
    // diagnostic and triage so a manual fix applies without a code deploy.
    const carfaxKeyOverrides = await getCarfaxOverridesMap(db);

    const existingCache = await getCachedPlan(db, vin, shopId, mileage);
    if (existingCache && !carfaxDiagMode) {
      return NextResponse.json({
        ok: true,
        vin,
        cached: true,
        message: "Plan already cached",
        duration: Date.now() - startTime,
      }, { status: 200 });
    }
    
    console.log(`[PlanBuild] Shop ${shopId}: Building full plan for ${vin} at ${mileage} miles`);

    const shopDoc = await db.collection("shops").findOne({ shopId });
    const soonMiles = shopDoc?.maintenance?.dueSoonMiles ?? shopDoc?.settings?.planPage?.soonMiles ?? DEFAULT_SOON_MILES;
    const soonDays = shopDoc?.maintenance?.dueSoonDays ?? shopDoc?.settings?.planPage?.soonDays ?? DEFAULT_SOON_DAYS;
    // Unify with the dashboard plan page + extension, which both read
    // `preferences.showInspectItems` defaulting to TRUE. The old
    // `settings.planPage.showInspectItems` field is never written by the
    // settings UI (it persists to preferences.showInspectItems), so the
    // previous `?? false` silently hid inspect rows in every cached plan
    // regardless of the shop's actual setting. Keep the legacy field as a
    // last-resort fallback for any pre-migration shop docs.
    const showInspectItems =
      shopDoc?.preferences?.showInspectItems ??
      shopDoc?.settings?.planPage?.showInspectItems ??
      true;
    // Task #336: align with the dashboard + extension which both read
    // `preferences.distanceUnit`. Old `settings.distanceUnit` kept as a
    // legacy fallback so any pre-migration shop docs still resolve.
    // Resolved through the central policy so a miles-only provider (Tekmetric /
    // Shop-Ware) can never build a plan in kilometers even if a stale/bad
    // preference is present — that would inflate the VHI score.
    const distanceUnit = resolveShopDistanceUnit(shopDoc as ShopDistanceDoc | null);
    const rawIntervals: Record<string, ShopIntervalOverride> = shopDoc?.maintenance?.intervals ?? {};
    const intervalApplyMode: string = shopDoc?.maintenance?.intervalApplyMode || "always";
    const LEGACY_KEY_MAP: Record<string, string[]> = {
      differential: ["front_differential", "rear_differential"],
      alignment: ["wheel_alignment"],
      brake_pads: ["front_brake_pads", "rear_brake_pads"],
    };
    const shopIntervals: Record<string, ShopIntervalOverride> = { ...rawIntervals };
    for (const [oldKey, newKeys] of Object.entries(LEGACY_KEY_MAP)) {
      if (shopIntervals[oldKey]) {
        for (const nk of newKeys) {
          if (!shopIntervals[nk]) shopIntervals[nk] = shopIntervals[oldKey];
        }
      }
    }
    // Task #803: enabled chemical-provider schedules (e.g. BG) become extra
    // plan variants/tabs. Empty for most shops — the multi-plan path is
    // only taken when at least one enabled provider defines intervals.
    const chemicalProviders = getEnabledChemicalProviders(
      shopDoc?.maintenance?.chemicalProviders
    );

    const vinUpper = vin.toUpperCase();
    const vinRegex = new RegExp(`^${vinUpper}$`, 'i');

    // Task #613: on the interactive (fast) build, cap the DataOne OEM race at
    // a few seconds instead of 15s. A cached OEM schedule (the common case)
    // resolves well under this; a true cache MISS that needs a live decode
    // falls back to building without OEM data rather than blocking the tech
    // on the button. Background/partner builds keep the original 15s budget.
    const oemTimeoutMs = fast ? 3000 : 15000;
    // Task #737: cancel the race timer once the OEM lookup resolves so the
    // "DataOne timeout" warning only fires on REAL timeouts. Before this fix
    // the timer kept running after the lookup won the race, logging a
    // spurious timeout line on essentially every build (~146/hour in prod)
    // and drowning out genuine stalls.
    let oemRaceTimer: NodeJS.Timeout | undefined;
    const oemWithTimeout = Promise.race([
      getMaintenanceScheduleCached(vin).finally(() => {
        if (oemRaceTimer) clearTimeout(oemRaceTimer);
      }),
      new Promise<Awaited<ReturnType<typeof getMaintenanceScheduleCached>>>((resolve) => {
        oemRaceTimer = setTimeout(() => {
          console.warn(`[PlanBuild] DataOne timeout (${oemTimeoutMs}ms${fast ? ", fast" : ""}) for ${vin}, continuing without OEM data`);
          resolve({ ok: false, vin, squish: '', count: 0, items: [], error: 'timeout', source: 'cache' as const });
        }, oemTimeoutMs);
      })
    ]);
    const [autoCfg, carfaxCfg, protractorCfg, autoVitalsCfg, oemData] = await Promise.all([
      resolveAutoflowConfig(shopId),
      resolveCarfaxConfig(shopId),
      resolveProtractorConfig(shopId),
      resolveAutoVitalsConfig(shopId),
      oemWithTimeout,
    ]);

    const vehicleDoc = await db.collection("vehicles").findOne(
      { shopId, vin: vinUpper },
      { projection: { year: 1, make: 1, model: 1, declinedServices: 1, oilDutyPreference: 1 } }
    );
    const vehicleYear = vehicleDoc?.year ?? oemData.vehicle?.year ?? null;
    const vehicleTransType: string | null = (oemData.vehicle as any)?.transType || null;

    // Task #166: per-vehicle Normal vs Severe duty toggle. Default Severe.
    const oilDutyPreference: "normal" | "severe" =
      vehicleDoc?.oilDutyPreference === "normal" ? "normal" : "severe";

    // Task #166: classify engine risk (baseline + Mongo overrides).
    const engineProfile: EngineProfile = {
      year: oemData.vehicle?.year ?? null,
      make: oemData.vehicle?.make ?? null,
      model: oemData.vehicle?.model ?? null,
      engine_name: oemData.vehicle?.engine ?? null,
      engine_size: (oemData.vehicle as any)?.engine_size ?? null,
      engine_cylinders: (oemData.vehicle as any)?.engine_cylinders ?? null,
      engine_block: (oemData.vehicle as any)?.engine_block ?? null,
      engine_induction: (oemData.vehicle as any)?.engine_induction ?? null,
      engine_aspiration: (oemData.vehicle as any)?.engine_aspiration ?? null,
      fuel_type: (oemData.vehicle as any)?.fuel_type ?? null,
    };
    let engineRiskOverrides: EngineRiskOverride[] = [];
    try {
      engineRiskOverrides = await loadEngineRiskOverrides(db);
    } catch (err) {
      console.warn(`[PlanBuild] engine_risk_overrides load failed for ${vin}:`, err);
    }
    const engineRisk = classifyEngineRisk(engineProfile, engineRiskOverrides);

    const [protractorWOs, tekmetricWOs] = await Promise.all([
      db.collection("protractor_work_orders").find({
        shopId,
        $or: [
          { vin: vinUpper },
          { "data.VIN": vinUpper },
          { "ServiceItem.VIN": vinUpper }
        ]
      }).sort({ "Header.LastModifiedTime": -1 }).limit(20).toArray(),
      db.collection("tekmetric_work_orders").find({
        shopId: { $in: [String(shopId), Number(shopId)] },
        vin: vinUpper
      }).sort({ completedDate: -1 }).limit(50).toArray(),
    ]);

    // Phase C: on-demand inspection fallback. With polling-side inspection
    // fetching gated behind TEKMETRIC_POLLING_FETCH_INSPECTIONS, some cache
    // rows can show DVI signals (inspectionUrl/inspectionShareDate) but an
    // empty `inspections` array — e.g. when Inspection.Complete arrived before
    // we knew about that RO, or the webhook was dropped. Backfill them in
    // parallel here, mutating the in-memory docs so the read sites below see
    // the same shape as the cached path. Soft-fail; concurrency-bounded so a
    // big VIN history doesn't fan out to dozens of API calls.
    try {
      const tekShopIdForFallback = (shopDoc as any)?.tekmetric?.shopId;
      const xAuthTokenForFallback = (shopDoc as any)?.tekmetric?.xAuthToken;
      if (tekShopIdForFallback && xAuthTokenForFallback) {
        const needsFetch = tekmetricWOs.filter((wo: any) => {
          const hasSignal = !!wo.inspectionUrl || !!wo.inspectionShareDate || !!wo.dviDone;
          const empty = !Array.isArray(wo.inspections) || wo.inspections.length === 0 ||
            // pre-Phase-C cache rows sometimes hold only the partial event
            // payload (no `inspectionTasks`), which the read sites can't use.
            !wo.inspections.some((i: any) => Array.isArray(i?.inspectionTasks) && i.inspectionTasks.length > 0);
          return hasSignal && empty && wo.workOrderId;
        });
        if (needsFetch.length > 0) {
          // Cap parallelism at 4 to stay polite to the Tekmetric rate limit
          // (single-VIN plan-build × 50-WO ceiling × 4 concurrent ≈ 200 reqs
          // worst case, but in practice almost always ≤ a handful).
          const CONCURRENCY = 4;
          // Task #613: bound this on-demand backfill tightly on the interactive
          // build so it can't add several seconds to the button. Inspections it
          // does manage to fetch within the budget are still persisted below for
          // future requests; the rest are picked up by a later (background or
          // webhook) build. Background/partner builds keep the original 4s.
          const BUDGET_MS = fast ? 1200 : 4000;
          const start = Date.now();
          let cursor = 0;
          const fetched: number[] = [];
          await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, needsFetch.length) }).map(async () => {
              while (true) {
                if (Date.now() - start > BUDGET_MS) return;
                const idx = cursor++;
                if (idx >= needsFetch.length) return;
                const wo = needsFetch[idx];
                try {
                  const insps = await getRepairOrderInspectionsWithXAuth(
                    Number(wo.workOrderId),
                    Number(tekShopIdForFallback),
                    xAuthTokenForFallback
                  );
                  if (Array.isArray(insps) && insps.length > 0) {
                    wo.inspections = insps;
                    fetched.push(Number(wo.workOrderId));
                    // Persist for next request so we don't re-fetch every plan build.
                    db.collection("tekmetric_work_orders").updateOne(
                      { _id: wo._id },
                      { $set: { inspections: insps, inspectionsFetchedAt: new Date(), inspectionsSource: "on-demand" } }
                    ).catch(() => {});
                  }
                } catch (err: any) {
                  console.warn(`[PlanBuild] On-demand inspection fetch failed for RO ${wo.workOrderId}: ${err?.message}`);
                }
              }
            })
          );
          if (fetched.length > 0) {
            console.log(`[PlanBuild] Shop ${shopId} VIN ${vinUpper}: on-demand inspections fetched for ROs [${fetched.join(",")}] (${needsFetch.length} candidates, ${Date.now() - start}ms)`);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[PlanBuild] On-demand inspection fallback errored:`, err?.message);
    }

    const shopServiceHistory: ShopServiceHistory[] = [];
    for (const wo of protractorWOs) {
      const wMileage = wo.Odometer ?? wo.OutUsage ?? wo.data?.Odometer ?? null;
      const dateStr = wo.Header?.LastModifiedTime ?? wo.Header?.CreationTime ?? wo.data?.Header?.LastModifiedTime ?? null;
      const date = dateStr ? new Date(dateStr) : null;
      const servicePackages = wo.ServicePackages ?? wo.data?.ServicePackages ?? [];
      for (const pkg of servicePackages) {
        const serviceName = pkg.Title ?? pkg.Description ?? "";
        if (serviceName) shopServiceHistory.push({ serviceName, mileage: wMileage, date });
        for (const line of pkg.ServicePackageLines ?? []) {
          const lineName = line.Description ?? "";
          if (lineName && lineName !== serviceName) shopServiceHistory.push({ serviceName: lineName, mileage: wMileage, date });
        }
      }
    }
    // Track which (workOrderId, servicePackageId) combos came from full WO docs
    // so the job_index fallback below doesn't double-count them.
    const seenFromWoDocs = new Set<string>();

    for (const wo of tekmetricWOs) {
      // Treat status as "closed" if completedDate is present OR statusCode is terminal.
      // Older/backfilled WO docs may have completedDate=null/undefined even though
      // they're truly invoiced — so we also accept a terminal statusCode.
      const statusCode = String(wo.statusCode || wo.data?.repairOrderStatus?.code || "").toUpperCase();
      const terminalStatus = ["POSTED", "INVOICED", "INVOICE", "COMPLETED", "CLOSED"].includes(statusCode);
      const isCompleted = !!wo.completedDate || terminalStatus;
      const wMileage =
        (typeof wo.odometer === "number" && wo.odometer > 0 ? wo.odometer : null) ??
        (typeof wo.data?.milesOut === "number" && wo.data.milesOut > 0 ? wo.data.milesOut : null) ??
        (typeof wo.data?.milesIn === "number" && wo.data.milesIn > 0 ? wo.data.milesIn : null);
      const date = wo.completedDate
        ? new Date(wo.completedDate)
        : (wo.updatedDate ? new Date(wo.updatedDate) : null);
      const jobs = wo.data?.jobs ?? wo.jobs ?? [];
      for (const job of jobs) {
        // Task #608: a customer-declined (unauthorized) job is NOT performed
        // service, even on a posted/closed RO. It must never anchor an
        // interval. The legacy filter below only skipped open ROs, so declined
        // jobs on terminal ROs leaked through as false "last done" anchors.
        if (job.authorized === false) continue;
        if (!isCompleted && !job.authorized) continue;
        const serviceName = job.name ?? job.description ?? "";
        if (serviceName) shopServiceHistory.push({ serviceName, mileage: wMileage, date });
        if (job.id != null) {
          seenFromWoDocs.add(`${wo.workOrderId}:${job.id}`);
        }
      }
    }

    // ---- job_index fallback ----
    // tekmetric_work_orders is often sparse (full WO docs missing or lacking
    // jobs[]) for shops with backfill but limited live sync. job_index is the
    // authoritative shop-history table written by every backfill / cron / webhook.
    // Pull it as a defensive secondary source so plan-build never misses real
    // service history just because the WO doc didn't get jobs persisted.
    try {
      // Sort newest-first so when limit truncates we keep the most recent
      // service history (oldest entries are far less useful for "last service"
      // signals). Without explicit sort, Mongo natural order is non-deterministic.
      const jobIndexEntries = await db.collection("job_index").find({
        shopId: { $in: [Number(shopId), String(shopId)] },
        $or: [
          { "vehicle.vin": vinUpper },
          { vin: vinUpper },
        ],
      })
        .sort({ closedDate: -1, closedAt: -1, performedAt: -1, completedAt: -1, indexedAt: -1 })
        .limit(500)
        .toArray();

      // Track ALL appended (workOrderId, servicePackageId) keys — including
      // those added by this fallback — to prevent duplicates from cross-source
      // collisions in job_index itself, not just WO-loop overlaps.
      const seenAppendedKeys = new Set<string>(seenFromWoDocs);

      // First pass: collect entries; track which still need mileage so we can
      // batch a single parent-WO lookup instead of N round-trips. This guards
      // against the historical bug where backfills lost `mileage` on
      // job_index rows (see IMPROVEMENT_BACKLOG.md item #9).
      type PendingEntry = { serviceName: string; mileage: number | null; date: Date | null; woId: string };
      const pendingEntries: PendingEntry[] = [];
      const woIdsNeedingMileage = new Set<string>();

      for (const ji of jobIndexEntries) {
        const woId = String(ji.workOrderId ?? "");
        const svcId = String(ji.servicePackageId ?? "");
        const dedupKey = `${woId}:${svcId}`;
        if (woId && svcId && seenAppendedKeys.has(dedupKey)) continue;

        // Task #608: skip declined/unperformed rows so they never become a
        // "last done" anchor. Legacy rows lacking an explicit flag are treated
        // as performed (conservative) — see isDeclinedJobIndexRow.
        if (isDeclinedJobIndexRow(ji)) continue;

        const serviceName = ji.jobName || ji.job?.title || ji.title || "";
        if (!serviceName) continue;

        const dateRaw = ji.closedDate || ji.closedAt || ji.performedAt || ji.completedAt || ji.indexedAt || null;
        const date = dateRaw ? new Date(dateRaw) : null;
        if (date && isNaN(date.getTime())) continue;

        const mileage =
          (typeof ji.mileage === "number" && ji.mileage > 0 ? ji.mileage : null) ??
          (typeof ji.odometer === "number" && ji.odometer > 0 ? ji.odometer : null) ??
          (typeof ji.vehicle?.mileage === "number" && ji.vehicle.mileage > 0 ? ji.vehicle.mileage : null) ??
          null;

        if (mileage == null && woId) woIdsNeedingMileage.add(woId);
        pendingEntries.push({ serviceName, mileage, date, woId });
        if (woId && svcId) seenAppendedKeys.add(dedupKey);
      }

      // Defensive enrichment: for any still-missing mileage, batch-fetch parent
      // tekmetric_work_orders and use its odometer/milesOut/milesIn. Helps when
      // ingestion populated the parent WO but lost mileage on job_index.
      // (Historical rows may also lack it on the parent — those stay null and
      // computeAnchorMiles() will estimate, or the backfill script can fill them.)
      if (woIdsNeedingMileage.size > 0) {
        try {
          // tekmetric_work_orders stores workOrderId as string and shopId as
          // either string or number across docs. The {shopId, workOrderId}
          // compound index covers this query directly.
          const idArr = Array.from(woIdsNeedingMileage);
          const numericIds = idArr.map((s) => Number(s)).filter((n) => Number.isFinite(n));
          const parentDocs = await db.collection("tekmetric_work_orders").find(
            {
              shopId: { $in: [Number(shopId), String(shopId)] },
              workOrderId: { $in: [...idArr, ...numericIds] },
            },
            { projection: { workOrderId: 1, odometer: 1, milesIn: 1, milesOut: 1, mileageIn: 1, mileageOut: 1 } },
          ).toArray();

          const odoByWoId = new Map<string, number>();
          for (const p of parentDocs) {
            const odo =
              (typeof p.milesOut === "number" && p.milesOut > 0 ? p.milesOut : null) ??
              (typeof p.mileageOut === "number" && p.mileageOut > 0 ? p.mileageOut : null) ??
              (typeof p.odometer === "number" && p.odometer > 0 ? p.odometer : null) ??
              (typeof p.milesIn === "number" && p.milesIn > 0 ? p.milesIn : null) ??
              (typeof p.mileageIn === "number" && p.mileageIn > 0 ? p.mileageIn : null) ??
              null;
            if (odo == null) continue;
            if (p.workOrderId != null) odoByWoId.set(String(p.workOrderId), odo);
          }

          let enriched = 0;
          for (const e of pendingEntries) {
            if (e.mileage != null || !e.woId) continue;
            const odo = odoByWoId.get(e.woId);
            if (typeof odo === "number" && odo > 0) {
              e.mileage = odo;
              enriched++;
            }
          }
          if (enriched > 0) {
            console.log(
              `[PlanBuild] Shop ${shopId} VIN ${vinUpper}: enriched ${enriched}/${woIdsNeedingMileage.size} missing-mileage rows from parent tekmetric_work_orders`
            );
          }
        } catch (enrichErr: any) {
          console.warn(`[PlanBuild] parent-WO mileage enrichment failed for ${vinUpper}: ${enrichErr.message}`);
        }
      }

      for (const e of pendingEntries) {
        shopServiceHistory.push({ serviceName: e.serviceName, mileage: e.mileage, date: e.date });
      }

      if (jobIndexEntries.length > 0) {
        console.log(
          `[PlanBuild] Shop ${shopId} VIN ${vinUpper}: pulled ${jobIndexEntries.length} job_index entries as shop-history fallback`
        );
      }
    } catch (jiErr: any) {
      console.warn(`[PlanBuild] job_index fallback failed for ${vinUpper}: ${jiErr.message}`);
    }

    const unmatchedJobNames: string[] = [];
    for (const sh of shopServiceHistory) {
      const keys = toKeyFromFreeText(sh.serviceName || "");
      if (keys.length === 0 && sh.serviceName) {
        unmatchedJobNames.push(sh.serviceName);
      }
    }
    if (unmatchedJobNames.length > 0) {
      console.log(`[PlanBuild] Shop ${shopId} VIN ${vin}: ${unmatchedJobNames.length} unmatched job names: ${unmatchedJobNames.slice(0, 10).join(" | ")}`);
    }

    // Resolve the latest RO number for this VIN so the Autoflow DVI fetch
    // below can fire regardless of which SMS is primary. Order: Protractor,
    // Tekmetric, Shop-Ware, then Autoflow events as a final fallback.
    let latestRoNumber: string | null = null;
    if (protractorWOs.length > 0) {
      const wo = protractorWOs[0];
      latestRoNumber = wo.workOrderNumber || wo.WorkOrderNumber || wo.data?.WorkOrderNumber || null;
    }
    if (!latestRoNumber && tekmetricWOs.length > 0) {
      const wo = tekmetricWOs[0] as any;
      const candidate =
        wo.workOrderNumber ??
        wo.repairOrderNumber ??
        wo.data?.repairOrderNumber ??
        wo.workOrderId ??
        null;
      latestRoNumber = candidate != null ? String(candidate) : null;
    }
    if (!latestRoNumber) {
      try {
        const shopwareRos = await db.collection("shopware_repair_orders").find({
          mosShopId: { $in: [Number(shopId), String(shopId)] },
          vin: vinUpper,
        }).sort({ syncedAt: -1, updatedAt: -1 }).limit(1).toArray();
        if (shopwareRos.length > 0 && shopwareRos[0].number != null) {
          latestRoNumber = String(shopwareRos[0].number);
        }
      } catch (swErr: any) {
        console.warn(`[PlanBuild] Shop-Ware RO lookup failed for ${vinUpper}: ${swErr.message}`);
      }
    }
    if (!latestRoNumber) {
      try {
        const eventRos = await db.collection("events").aggregate([
          {
            $match: {
              $and: [
                { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
                { provider: "autoflow" },
                {
                  $expr: {
                    $eq: [
                      { $toUpper: { $ifNull: ["$vehicleVin", { $ifNull: ["$vin", "$payload.vehicle.vin"] }] } },
                      vinUpper,
                    ],
                  },
                },
              ],
            },
          },
          {
            $addFields: {
              roNumber: { $ifNull: ["$payload.ticket.invoice", { $ifNull: ["$payload.ticket.id", "$roNumber"] }] },
            },
          },
          { $match: { roNumber: { $ne: null } } },
          { $sort: { receivedAt: -1, createdAt: -1 } },
          { $limit: 1 },
          { $project: { roNumber: 1 } },
        ]).toArray();
        if (eventRos[0]?.roNumber != null) {
          latestRoNumber = String(eventRos[0].roNumber);
        }
      } catch (afErr: any) {
        console.warn(`[PlanBuild] Autoflow events RO fallback failed for ${vinUpper}: ${afErr.message}`);
      }
    }

    // Task #613: on the fast (interactive) path, prefer a recent cached CARFAX
    // snapshot and refresh in the background rather than blocking the button on
    // a live CARFAX call. Even the no-snapshot blocking fetch is capped by a
    // small budget so a hung CARFAX upstream can't stall the build — on timeout
    // we continue without CARFAX (the plan still builds from shop history/OEM).
    // Task #737: same uncancelled-timer pattern as the OEM race above — clear
    // the timer once the CARFAX fetch resolves so the timeout warn only fires
    // on real timeouts.
    let carfaxRaceTimer: NodeJS.Timeout | undefined;
    const carfaxFetch = fast
      ? Promise.race([
          fetchCarfaxStaleWhileRevalidate(shopId, vin, CACHE_TTL_MS).finally(() => {
            if (carfaxRaceTimer) clearTimeout(carfaxRaceTimer);
          }),
          new Promise<{ ok: false }>((resolve) => {
            carfaxRaceTimer = setTimeout(() => {
              console.warn(`[PlanBuild] CARFAX fast-path timeout for ${vin}, continuing without CARFAX`);
              resolve({ ok: false });
            }, 4000);
          }),
        ])
      : fetchCarfaxWithCache(shopId, vin, CACHE_TTL_MS);
    const [carfaxResult, protractorVehicleResult, avInspectionResult] = await Promise.all([
      carfaxCfg.configured ? carfaxFetch : Promise.resolve({ ok: false }),
      protractorCfg.configured ? fetchProtractorVehicle(shopId, vin, PROTRACTOR_CACHE_TTL) : Promise.resolve({ ok: false }),
      autoVitalsCfg.configured ? fetchAutoVitalsInspectionByVin(shopId, vin, PROTRACTOR_CACHE_TTL) : Promise.resolve({ ok: false }),
    ]);

    let dvi: any = { ok: false };
    if (latestRoNumber && autoCfg.configured) {
      dvi = await fetchDviWithCache(shopId, String(latestRoNumber), DVI_CACHE_TTL);
    }

    const autoflowDviFindings: Array<{ name?: string; status?: string | number; source?: string }> =
      (dvi as any).ok && Array.isArray((dvi as any).categories)
        ? (dvi as any).categories.flatMap((c: any) =>
            Array.isArray(c.items) ? c.items.map((it: any) => ({ name: it.name, status: it.status, source: "autoflow" })) : []
          )
        : [];

    let autoVitalsDviFindings: Array<{ name?: string; status?: string | number; source?: string }> = [];
    if ((avInspectionResult as any).ok && (avInspectionResult as any).items) {
      autoVitalsDviFindings = (avInspectionResult as any).items
        .filter((item: any) => item.status === "red" || item.status === "yellow")
        .map((item: any) => ({
          name: item.name,
          status: item.status === "red" ? "0" : "1",
          source: "autovitals"
        }));
    }

    let tekmetricDviFindings: Array<{ name?: string; status?: string | number; source?: string; finding?: string }> = [];
    if (tekmetricWOs.length > 0) {
      for (const tekRo of tekmetricWOs) {
        const woInspections = tekRo.inspections || [];
        if (!Array.isArray(woInspections) || woInspections.length === 0) continue;
        for (const inspection of woInspections) {
          for (const group of inspection.inspectionTasks || []) {
            for (const task of group.tasks || []) {
              const code = task.inspectionRating?.code;
              if (code === "RQRSATTN") {
                tekmetricDviFindings.push({ name: task.name, status: "0", source: "tekmetric", finding: task.finding });
              } else if (code === "MAYRQRATTN") {
                tekmetricDviFindings.push({ name: task.name, status: "1", source: "tekmetric", finding: task.finding });
              }
            }
          }
          if (tekmetricDviFindings.length === 0 && inspection.items) {
            for (const item of inspection.items) {
              if (item.status === "bad") {
                tekmetricDviFindings.push({ name: item.name, status: "0", source: "tekmetric" });
              } else if (item.status === "marginal") {
                tekmetricDviFindings.push({ name: item.name, status: "1", source: "tekmetric" });
              }
            }
          }
        }
        if (tekmetricDviFindings.length > 0) {
          console.log(`[PlanBuild] Tekmetric DVI: ${tekmetricDviFindings.length} findings from cached inspections on RO ${tekRo.workOrderId}`);
          break;
        }
      }
    }

    let unresolvedHistoricalFindings: Array<{ name?: string; status?: string | number; source?: string }> = [];
    if (tekmetricWOs.length > 0) {
      const historicalItems: Array<{
        name: string;
        status: "bad" | "marginal";
        inspectionDate: Date | null;
        workOrderId: string;
      }> = [];

      for (const wo of tekmetricWOs) {
        const woInspections = wo.inspections || [];
        if (!Array.isArray(woInspections) || woInspections.length === 0) continue;
        const woDate = wo.completedDate ? new Date(wo.completedDate) 
          : wo.updatedDate ? new Date(wo.updatedDate) 
          : wo.createdDate ? new Date(wo.createdDate) : null;

        for (const insp of woInspections) {
          let foundFromGroups = false;
          for (const group of insp.inspectionTasks || []) {
            for (const task of group.tasks || []) {
              const code = task.inspectionRating?.code;
              if (code === "RQRSATTN" || code === "MAYRQRATTN") {
                foundFromGroups = true;
                historicalItems.push({
                  name: task.name || "",
                  status: code === "RQRSATTN" ? "bad" : "marginal",
                  inspectionDate: woDate,
                  workOrderId: String(wo.workOrderId),
                });
              }
            }
          }
          if (!foundFromGroups) {
            for (const item of insp.items || []) {
              if (item.status === "bad" || item.status === "marginal") {
                historicalItems.push({
                  name: item.name || item.categoryName || "",
                  status: item.status,
                  inspectionDate: woDate,
                  workOrderId: String(wo.workOrderId),
                });
              }
            }
          }
        }
      }

      if (historicalItems.length > 0) {
        const allHistoryByKey = new Map<string, { date: Date | null }[]>();
        for (const sh of shopServiceHistory) {
          const keys = toKeyFromFreeText(sh.serviceName || "");
          for (const k of keys) {
            if (!allHistoryByKey.has(k)) allHistoryByKey.set(k, []);
            allHistoryByKey.get(k)!.push({ date: sh.date });
          }
        }

        for (const r of (carfaxResult as any).ok ? ((carfaxResult as any).serviceRecords || []) : []) {
          const desc = String(r.description || "").trim();
          const rDate = parseCarfaxDate(r?.date ?? null);
          const keys = toKeyFromFreeText(desc);
          for (const k of keys) {
            if (!allHistoryByKey.has(k)) allHistoryByKey.set(k, []);
            allHistoryByKey.get(k)!.push({ date: rDate });
          }
        }

        const seenUnresolved = new Set<string>();
        const currentDviNames = new Set(
          [...autoflowDviFindings, ...autoVitalsDviFindings, ...tekmetricDviFindings]
            .map(f => (f.name || "").toLowerCase().trim())
            .filter(Boolean)
        );

        for (const hi of historicalItems) {
          if (!hi.name) continue;
          const nameLower = hi.name.toLowerCase().trim();
          if (currentDviNames.has(nameLower)) continue;

          const serviceKey = toKeyFromName(hi.name);
          const dedupKey = serviceKey || nameLower;
          if (seenUnresolved.has(dedupKey)) continue;

          // Task #746: route the "remedied since inspection" decision through
          // the one shared helper so plan-build and the DVI pre-fill can never
          // disagree. Plan-build supplies the service-key-indexed history
          // (shop history + CARFAX) and the raw shop history for the
          // name-substring fallback; behavior is identical to the prior inline
          // logic.
          const remedied = isRemediedSinceInspection(
            { date: hi.inspectionDate, serviceKey, name: hi.name },
            { byServiceKey: allHistoryByKey, nameEntries: shopServiceHistory },
          );

          if (!remedied) {
            seenUnresolved.add(dedupKey);
            unresolvedHistoricalFindings.push({
              name: hi.name,
              status: hi.status === "bad" ? "0" : "1",
              source: "tekmetric",
            });
          }
        }

        if (unresolvedHistoricalFindings.length > 0) {
          console.log(`[PlanBuild] Unresolved historical inspections for ${vin}: ${unresolvedHistoricalFindings.length} items`);
        }
      }
    }

    // Task #860: findings parsed from public DVI share links found on
    // Protractor WOs (AutoServe1, avlink.io, AutoFlow microsites, …).
    // Read-only Mongo lookup; returns [] unless links have been ingested.
    const dviLinkFindings = await gatherDviLinkFindings(shopId, vin);

    const dviFindings = [...autoflowDviFindings, ...autoVitalsDviFindings, ...tekmetricDviFindings, ...dviLinkFindings, ...unresolvedHistoricalFindings];

    let protractorDeferredWork: ProtractorDeferredWork[] = [];
    if (protractorCfg.configured && (protractorVehicleResult as any).ok && (protractorVehicleResult as any).vehicle?.ID) {
      const deferredResult = await fetchProtractorDeferredWork(shopId, vin, (protractorVehicleResult as any).vehicle.ID, PROTRACTOR_CACHE_TTL);
      if (deferredResult.ok && deferredResult.deferredWork) {
        protractorDeferredWork = deferredResult.deferredWork;
      }
    }

    const carfaxRecords = (carfaxResult as any).ok ? ((carfaxResult as any).serviceRecords || []) : [];
    const carfaxCategories = (carfaxResult as any).ok ? ((carfaxResult as any).serviceCategories || []) : [];

    // Task #655: classify how every CARFAX record / category matched the
    // canonical service keys (mirrors triage's matching + shop-history dedup).
    // Always log the unmatched ones so wording gaps surface fleet-wide; when a
    // platform admin asks for `diag=carfax`, return the full per-record
    // breakdown instead of building/caching a plan.
    const carfaxDiagnostics = buildCarfaxMatchDiagnostics({
      carfaxRecords,
      carfaxCategories,
      shopServiceHistory,
      vehicleYear,
      today: new Date(),
      carfaxKeyOverrides,
    });
    for (const d of carfaxDiagnostics.entries) {
      if (d.unmatched) {
        recordUnmatchedCarfaxDescription(d.description, {
          vin,
          shopId,
          source: d.source,
        });
      }
    }
    if (carfaxDiagMode) {
      return NextResponse.json(
        {
          ok: true,
          vin,
          shopId,
          mileage,
          vehicleYear,
          carfaxAvailable: !!(carfaxResult as any).ok,
          shopHistoryCount: shopServiceHistory.length,
          summary: carfaxDiagnostics.summary,
          entries: carfaxDiagnostics.entries,
          note: "Diagnostic only — no plan was built or cached.",
          duration: Date.now() - startTime,
        },
        { status: 200 },
      );
    }

    let mpdBlended: number | null = null;
    if ((carfaxResult as any).ok && Array.isArray((carfaxResult as any).serviceRecords)) {
      const recs = (carfaxResult as any).serviceRecords
        .map((r: any) => ({ date: parseCarfaxDate(r?.date ?? null), miles: typeof r?.odometer === "number" ? r.odometer : null }))
        .filter((r: any) => r.date && typeof r.miles === "number") as { date: Date; miles: number }[];
      recs.sort((a, b) => b.date.getTime() - a.date.getTime());

      const todayMiles = mileage;
      let fromToday: number | null = null, fromTwo: number | null = null;

      if (todayMiles != null && recs[0]) {
        const d = Math.max(1, Math.abs(new Date().getTime() - recs[0].date.getTime()) / (1000 * 60 * 60 * 24));
        const val = (todayMiles - recs[0].miles) / d;
        fromToday = Math.abs(val) < 0.01 ? null : val;
      }
      if (recs[0] && recs[1]) {
        const d = Math.max(1, Math.abs(recs[0].date.getTime() - recs[1].date.getTime()) / (1000 * 60 * 60 * 24));
        fromTwo = (recs[0].miles - recs[1].miles) / d;
      }
      mpdBlended = fromToday != null && fromTwo != null ? (fromToday + fromTwo) / 2 : fromTwo ?? fromToday ?? null;
    }

    // Task #166: `toOEMItem` (in lib/plan-build/triage) now forwards the
    // Normal/Severe duty-cycle interval fields, so the engine-aware oil
    // logic in `triage()` works without any extra mapping here.
    const oemItems: OEMItem[] = (oemData.items || []).map(toOEMItem);

    const declinedServices: DeclinedServiceEntry[] = (vehicleDoc?.declinedServices || []).map((d: any) => ({
      serviceKey: d.serviceKey,
      serviceName: d.serviceName,
      mileage: d.mileage ?? null,
      reason: d.reason ?? null,
      declinedAt: d.declinedAt,
    }));

    // Task #808: fold Tekmetric declined/unauthorized jobs (job_index rows
    // with authorized === false, same source as the #741 extension list)
    // into the plan build. Tekmetric-connected shops only; fail-open so a
    // slow/failed Mongo read never blocks the build.
    let tekmetricDeclinedJobs: TekmetricDeclinedJob[] = [];
    if (shopDoc?.tekmetric?.shopId || shopDoc?.tekmetricShopId || shopDoc?.integrationProvider === "tekmetric") {
      try {
        const declinedRows = await listTekmetricDeferredWorkByVin(shopId, vinUpper, 50);
        tekmetricDeclinedJobs = declinedRows.map((r) => ({
          id: r.id,
          title: r.title,
          date: r.date,
          originalWorkOrderNumber: r.originalWorkOrderNumber,
        }));
      } catch (err) {
        console.log(`[PlanBuild] Tekmetric declined-work lookup error for ${vin}:`, err);
      }
    }

    // Customer-name fallback chain — see `lib/plan-build/customer-name.ts`
    // for the priority rules (Tekmetric → Protractor → Shop-Ware → vehicles).
    // We fetch each source lazily (only when prior sources resolved nothing)
    // and pass the raw docs into the pure resolver so the priority +
    // "Unknown Customer" sentinel handling is testable without a live Mongo.
    let tekmetricWorkOrderForName: { customerName?: string | null } | null = null;
    const tekmetricShopId = shopDoc?.tekmetric?.shopId || shopDoc?.tekmetricShopId;
    if (tekmetricShopId) {
      try {
        // Match by internal shopId + exact (uppercased) VIN so this uses the
        // { shopId, vin, completedDate } index. A case-insensitive `$regex` on
        // `vin` is non-indexable, and combined with the unindexed
        // `tekmetricShopId` $or branches it forced a full COLLSCAN of the
        // ~1.7M-row collection — saturating shared Mongo and starving the sync
        // crons fleet-wide. VINs are stored uppercased on write, so exact
        // equality is both correct and index-optimal.
        const cachedWO = await db.collection("tekmetric_work_orders").findOne(
          {
            shopId: { $in: [String(shopId), Number(shopId)] },
            vin: vinUpper,
          },
          // Task #960: sync-written mirror docs carry only Tekmetric's *Date
          // fields (updatedDate/createdDate), not updatedAt/createdAt —
          // include both so "most recent" holds for either writer.
          { sort: { updatedAt: -1, updatedDate: -1, createdAt: -1, createdDate: -1 }, projection: { workOrderNumber: 1, customerName: 1 } }
        );
        if (cachedWO) {
          if (cachedWO.workOrderNumber) latestRoNumber = String(cachedWO.workOrderNumber);
          tekmetricWorkOrderForName = { customerName: cachedWO.customerName ?? null };
        }
      } catch (err) {
        console.log(`[PlanBuild] MongoDB WO lookup error for ${vin}:`, err);
      }
    }

    const protractorVehicleForName =
      protractorCfg.configured && (protractorVehicleResult as any).ok
        ? ((protractorVehicleResult as any).vehicle ?? null)
        : null;

    let customerName = resolveCustomerName({
      tekmetricWorkOrder: tekmetricWorkOrderForName,
      protractorVehicle: protractorVehicleForName,
    });

    if (!customerName) {
      let shopWareWorkOrderForName: { customerName?: string | null } | null = null;
      try {
        // Task #998: flag-dispatched PG/Mongo facade read.
        const { findCachedWorkOrderCustomerName } = await import(
          "@/lib/data/repositories/plan-cache-store"
        );
        const swRo = await findCachedWorkOrderCustomerName(Number(shopId), vin, db);
        if (swRo) shopWareWorkOrderForName = { customerName: swRo.customerName ?? null };
      } catch (err) {
        console.log(`[PlanBuild] cached_work_orders customer lookup error for ${vin}:`, err);
      }
      customerName = resolveCustomerName({ shopWareWorkOrder: shopWareWorkOrderForName });
    }

    if (!customerName) {
      let vehicleDocForName: { customerName?: string | null } | null = null;
      try {
        const vDoc = await db.collection("vehicles").findOne(
          {
            vin: vin.toUpperCase(),
            shopId: { $in: [String(shopId), Number(shopId)] },
            customerName: { $exists: true, $nin: [null, ""] },
          },
          { projection: { customerName: 1 } }
        );
        if (vDoc) vehicleDocForName = { customerName: vDoc.customerName ?? null };
      } catch (err) {
        console.log(`[PlanBuild] vehicles customer lookup error for ${vin}:`, err);
      }
      customerName = resolveCustomerName({ vehicleDoc: vehicleDocForName });
    }

    // Task #803: all expensive fetch/anchor inputs are assembled once above;
    // triage() itself is pure and in-memory, so multi-plan variants (OE /
    // Shop / provider tabs) just re-run the projection with different
    // interval overrides on this same shared input.
    const triageInput = {
      oemItems,
      carfaxRecords,
      carfaxCategories,
      shopServiceHistory,
      currentMiles: mileage,
      dviFindings,
      protractorDeferredWork,
      declinedServices,
      tekmetricDeclinedJobs,
      soonMiles,
      soonDays,
      milesPerDay: mpdBlended,
      shopIntervals,
      intervalApplyMode,
      vehicleYear,
      vehicleTransType,
      fuelType: (oemData.vehicle as any)?.fuelType ?? (oemData.vehicle as any)?.fuel_type ?? null,
      engineRisk,
      oilDutyPreference,
      // Task #336: pass shop unit so OEM intervals are converted to km
      // for Canadian shops before being persisted to cached_plans.
      distanceUnit,
      // Task #655 (manual edit): apply operator CARFAX-description overrides
      // live so manual fixes anchor VHI services without a code deploy.
      carfaxKeyOverrides,
    };

    const buckets = triage(triageInput);

    const isInspectItem = (item: TriagedItem) => {
      // Task #198: keep inspect-only fluid rows (e.g. Mopar's "Inspect
      // transmission fluid") in the plan even when the shop has hidden
      // generic inspect items — they are usually the only OEM signal a
      // customer gets about that fluid, so dropping them silently
      // disappears the row entirely.
      if (item.inspectOnly) return false;
      // A shop-interval override ("use shop interval" on) declares this a
      // real recurring service — never hide it as a generic inspect row.
      if (item.usingShopInterval) return false;
      // Prefer the parsed action verb so the filter cannot be fooled by a
      // canonical display label that hides the original "Inspect …" wording.
      if (item.action === "inspect") return true;
      const title = (item.title || "").toLowerCase();
      return title.includes("inspect") || title.startsWith("check ");
    };
    
    const filteredBuckets = showInspectItems ? buckets : {
      overdue: buckets.overdue.filter(i => !isInspectItem(i)),
      dueSoon: buckets.dueSoon.filter(i => !isInspectItem(i)),
      upcoming: buckets.upcoming.filter(i => !isInspectItem(i)),
    };

    // Task #803: multi-plan variants (OE / Shop / one per enabled chemical
    // provider). Only computed when the shop actually has enabled providers —
    // zero extra work (and no `plans` field) for everyone else. Each variant
    // re-runs the pure in-memory triage projection with different interval
    // overrides; the inspect-item filter is applied per variant so
    // lifetime-fluid / inspect-only parity holds on every tab.
    let planVariants: CachedPlanVariant[] | undefined;
    if (chemicalProviders.length > 0) {
      const applyInspectFilter = (b: ReturnType<typeof triage>) =>
        showInspectItems ? b : {
          overdue: b.overdue.filter(i => !isInspectItem(i)),
          dueSoon: b.dueSoon.filter(i => !isInspectItem(i)),
          upcoming: b.upcoming.filter(i => !isInspectItem(i)),
        };
      const toCacheBuckets = (b: ReturnType<typeof triage>) => ({
        overdue: b.overdue.map(convertToCache),
        dueSoon: b.dueSoon.map(convertToCache),
        upcoming: b.upcoming.map(convertToCache),
      });

      // OE tab: factory schedule only — no shop interval overrides.
      const oeBuckets = applyInspectFilter(
        triage({ ...triageInput, shopIntervals: {} })
      );

      planVariants = [
        { id: "oe", kind: "oe", label: "OE Plan", buckets: toCacheBuckets(oeBuckets) },
        // Shop tab mirrors the primary buckets (already filtered).
        { id: "shop", kind: "shop", label: "Shop Plan", buckets: toCacheBuckets(filteredBuckets) },
        ...chemicalProviders.map((p): CachedPlanVariant => {
          const providerBuckets = applyInspectFilter(
            triage({
              ...triageInput,
              shopIntervals: providerIntervalsToOverrides(p),
              // Provider schedules always apply — they ARE the plan, not a
              // conditional per-service override.
              intervalApplyMode: "always",
            })
          );
          return {
            id: `provider:${p.id}`,
            kind: "provider",
            label: p.name,
            buckets: toCacheBuckets(providerBuckets),
          };
        }),
      ];
    }

    const planData: CachedPlanData = {
      buckets: {
        overdue: filteredBuckets.overdue.map(convertToCache),
        dueSoon: filteredBuckets.dueSoon.map(convertToCache),
        upcoming: filteredBuckets.upcoming.map(convertToCache),
      },
      vehicle: {
        year: oemData.vehicle?.year ?? null,
        make: oemData.vehicle?.make ?? null,
        model: oemData.vehicle?.model ?? null,
        engine: oemData.vehicle?.engine ?? null,
        engineSize: (oemData.vehicle as any)?.engine_size ?? null,
        engineCylinders: (oemData.vehicle as any)?.engine_cylinders ?? null,
        engineInduction: (oemData.vehicle as any)?.engine_induction ?? null,
        engineAspiration: (oemData.vehicle as any)?.engine_aspiration ?? null,
      },
      // Task #803: multi-plan variants; undefined (field omitted) unless the
      // shop has enabled chemical providers.
      ...(planVariants ? { plans: planVariants } : {}),
      currentMiles: mileage,
      mpdBlended,
      customerName,
      latestRoNumber,
      distanceUnit,
      soonMiles,
      soonDays,
      showInspectItems,
      deferredWork: protractorDeferredWork.length > 0 ? protractorDeferredWork.map(dw => ({
        ID: dw.ID,
        ServiceItemID: dw.ServiceItemID,
        Title: dw.Title,
        Description: dw.Description,
      })) : undefined,
      engineRisk: {
        flagged: engineRisk.flagged,
        reasons: engineRisk.reasons,
        source: engineRisk.source,
        matchedOverrideId: engineRisk.matchedOverrideId ?? null,
        matchedOverrideLabel: engineRisk.matchedOverrideLabel ?? null,
      },
      oilDutyPreference,
    };

    // Task #391: detect mileage rollback (current odometer lower than a
    // previously reported reading from shop history or CARFAX). Persist
    // on the plan so external/internal readers can surface the warning
    // without re-running the math.
    try {
      const provider =
        (shopDoc as any)?.integrationProvider ||
        (tekmetricWOs.length > 0 ? "tekmetric" : protractorWOs.length > 0 ? "protractor" : null);
      const carfaxRecsForCheck =
        (carfaxResult as any).ok && Array.isArray((carfaxResult as any).serviceRecords)
          ? (carfaxResult as any).serviceRecords
          : [];
      const discrepancy = detectMileageDiscrepancy({
        currentMiles: mileage,
        shopHistory: shopServiceHistory,
        carfaxRecords: carfaxRecsForCheck,
        shopHistoryLabel: shopHistoryLabelFromProvider(provider),
      });
      if (discrepancy) {
        planData.mileageDiscrepancy = discrepancy;
        console.log(
          `[PlanBuild] Mileage discrepancy for ${vin}: current=${discrepancy.currentMiles} prior=${discrepancy.priorMiles} from ${discrepancy.priorSource} (gap=${discrepancy.gapMiles})`,
        );
      } else {
        planData.mileageDiscrepancy = null;
      }
    } catch (err: any) {
      console.warn(`[PlanBuild] mileage discrepancy detection failed for ${vin}: ${err?.message}`);
    }

    // Task #439: derive customer-facing data-quality signal so the VHI
    // surfaces (Detect Dog overlay, VHR shareable report) can replace the
    // red "0/CRITICAL" badge with a gray "Insufficient History — bring
    // vehicle in for inspection" treatment when the score is not
    // actually expressing vehicle condition but rather a lack of
    // anchoring data. The score itself is still persisted untouched for
    // internal tracking (Brandon — task #439 design call: hide from
    // customer, keep for ops).
    try {
      const cfxRes = carfaxResult as any;
      let carfaxStatus: NonNullable<CachedPlanData["dataQuality"]>["carfaxStatus"];
      if (!carfaxCfg.configured) {
        carfaxStatus = "not_configured";
      } else if (cfxRes?.ok) {
        carfaxStatus = carfaxRecords.length > 0 ? "ok" : "no_history";
      } else {
        const errStr = String(cfxRes?.error || "");
        carfaxStatus = /\b107\b/.test(errStr) ? "vin_rejected" : "error";
      }
      const anchorCount = carfaxRecords.length + shopServiceHistory.length;
      // Task #439 — design rule per architect review:
      // We only flip to "insufficient" when CARFAX *definitively* lacks
      // data (no_history / vin_rejected / not_configured) AND we have
      // fewer than 3 shop-side anchors. A transient CARFAX "error"
      // result is treated as fail-OPEN: the score keeps showing so a
      // 60-second upstream blip doesn't silently degrade every shop's
      // customer report. (Brandon — Schindler's F-150 case was
      // vin_rejected + zero shop history, the worst combo.)
      const carfaxDefinitelyEmpty =
        carfaxStatus === "no_history" ||
        carfaxStatus === "vin_rejected" ||
        carfaxStatus === "not_configured";
      const sufficient = !(carfaxDefinitelyEmpty && anchorCount < 3);
      const reasons: string[] = [];
      if (!sufficient) {
        if (carfaxStatus === "vin_rejected") reasons.push("carfax_vin_rejected");
        else if (carfaxStatus === "not_configured") reasons.push("carfax_not_configured");
        else if (carfaxStatus === "no_history") reasons.push("carfax_no_history");
        if (shopServiceHistory.length === 0) reasons.push("no_shop_history");
        if (reasons.length === 0) reasons.push("insufficient_anchors");
      }
      planData.dataQuality = {
        sufficient,
        carfaxStatus,
        anchorCount,
        carfaxRecordCount: carfaxRecords.length,
        shopHistoryCount: shopServiceHistory.length,
        reasons,
      };
    } catch (dqErr: any) {
      console.warn(`[PlanBuild] dataQuality derivation failed for ${vin}: ${dqErr?.message}`);
    }

    // Task #737: if the OEM lookup timed out or errored during this build,
    // the plan has no OEM items / vehicle attributes. Flag it so the cache
    // layer stores it with a short TTL and skips it on the next read
    // (forcing an OEM retry + rebuild) instead of serving the degraded plan
    // as the 4h truth. A legitimately empty schedule (ok:true, count 0) is
    // NOT flagged.
    if (oemData?.ok === false && oemData?.error) {
      planData.oemMissing = true;
      console.warn(`[PlanBuild] OEM lookup failed for ${vin} (${oemData.error}) — caching plan as degraded (oemMissing)`);
    }

    const cachedAt = new Date();
    await setCachedPlan(db, vin, shopId, mileage, planData);

    const duration = Date.now() - startTime;
    console.log(`[PlanBuild] Shop ${shopId}: Built and cached plan for ${vin} in ${duration}ms (OEM: ${oemItems.length}, Carfax: ${carfaxRecords.length}, ShopHistory: ${shopServiceHistory.length}, DVI: ${dviFindings.length}, UnresolvedHistory: ${unresolvedHistoricalFindings.length}, Deferred: ${protractorDeferredWork.length}, dataQuality=${planData.dataQuality?.sufficient ? "sufficient" : "INSUFFICIENT"}/${planData.dataQuality?.carfaxStatus})`);

    return NextResponse.json({
      ok: true,
      vin,
      built: true,
      message: "Plan built and cached",
      duration,
      counts: {
        overdue: filteredBuckets.overdue.length,
        dueSoon: filteredBuckets.dueSoon.length,
        upcoming: filteredBuckets.upcoming.length,
      },
      // Task #613: return the freshly-built plan so the caller (rebuildVhi) can
      // use it directly instead of sleeping 500ms and re-reading the cache.
      // The shape matches what getCachedPlan returns (`{ plan, createdAt }`),
      // so the caller treats it identically to a cache row it read itself.
      plan: planData,
      createdAt: cachedAt.toISOString(),
    }, { status: 200 });

  } catch (err: any) {
    console.error("[PlanBuild] Error:", err);
    // Task #510: per-shop error-rate alerting — emit a single
    // structured marker that the Better Stack PLAN_BUILD_5XX rule
    // groups by shopId. Wrapped in try/catch so a logging failure
    // never replaces the real 500 response.
    try {
      const { emitShopErrorEvent } = await import("@/lib/alerts/shop-error-marker");
      emitShopErrorEvent({
        group: "PLAN_BUILD_5XX",
        shopId: shopIdForError,
        status: 500,
        path: "/api/plan-build",
        method: "POST",
        message: err?.message,
      });
    } catch {}
    return NextResponse.json(
      { error: "Plan build failed", details: err.message },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json({ error: "Use POST method to build plan" }, { status: 405 });
}
