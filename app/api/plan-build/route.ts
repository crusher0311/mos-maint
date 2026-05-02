import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getCachedPlan, setCachedPlan, type CachedPlanData } from "@/lib/plan-cache";
import { toKeyFromFreeText, toKeyFromName } from "@/lib/service-keys";
import { resolveAutoflowConfig, fetchDviWithCache } from "@/lib/integrations/autoflow";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";
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
  type ShopIntervalOverride,
  type ShopServiceHistory,
} from "@/lib/plan-build/triage";
import { resolveCustomerName } from "@/lib/plan-build/customer-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours
const PROTRACTOR_CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours
const DVI_CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  
  try {
    let shopId: number;
    
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
    }

    const vin = req.nextUrl.searchParams.get("vin")?.toUpperCase();
    const mileageParam = req.nextUrl.searchParams.get("mileage");
    const mileage = mileageParam ? parseInt(mileageParam, 10) : null;
    
    if (!vin || vin.length !== 17) {
      return NextResponse.json({ error: "Valid 17-character VIN required" }, { status: 400 });
    }
    
    if (!mileage || mileage <= 0) {
      return NextResponse.json({ ok: true, vin, skipped: true, reason: "No mileage" }, { status: 200 });
    }

    const db = await getDb();

    const existingCache = await getCachedPlan(db, vin, shopId, mileage);
    if (existingCache) {
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
    const showInspectItems = shopDoc?.settings?.planPage?.showInspectItems ?? false;
    const distanceUnit = (shopDoc?.settings?.distanceUnit ?? "miles") as "miles" | "kilometers";
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

    const vinUpper = vin.toUpperCase();
    const vinRegex = new RegExp(`^${vinUpper}$`, 'i');

    const oemWithTimeout = Promise.race([
      getMaintenanceScheduleCached(vin),
      new Promise<Awaited<ReturnType<typeof getMaintenanceScheduleCached>>>((resolve) =>
        setTimeout(() => {
          console.warn(`[PlanBuild] DataOne timeout for ${vin}, continuing without OEM data`);
          resolve({ ok: false, vin, squish: '', count: 0, items: [], error: 'timeout', source: 'cache' as const });
        }, 15000)
      )
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
          const BUDGET_MS = 4000;
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

    const [carfaxResult, protractorVehicleResult, avInspectionResult] = await Promise.all([
      carfaxCfg.configured ? fetchCarfaxWithCache(shopId, vin, CACHE_TTL_MS) : Promise.resolve({ ok: false }),
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

          let remedied = false;
          if (hi.inspectionDate) {
            if (serviceKey) {
              const serviceRecords = allHistoryByKey.get(serviceKey) || [];
              remedied = serviceRecords.some(sr => 
                sr.date && sr.date.getTime() > hi.inspectionDate!.getTime()
              );
            }
            if (!remedied) {
              remedied = shopServiceHistory.some(sh => {
                if (!sh.date || sh.date.getTime() <= hi.inspectionDate!.getTime()) return false;
                const shName = (sh.serviceName || "").toLowerCase();
                return shName.includes(nameLower) || nameLower.includes(shName);
              });
            }
          }

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

    const dviFindings = [...autoflowDviFindings, ...autoVitalsDviFindings, ...tekmetricDviFindings, ...unresolvedHistoricalFindings];

    let protractorDeferredWork: ProtractorDeferredWork[] = [];
    if (protractorCfg.configured && (protractorVehicleResult as any).ok && (protractorVehicleResult as any).vehicle?.ID) {
      const deferredResult = await fetchProtractorDeferredWork(shopId, vin, (protractorVehicleResult as any).vehicle.ID, PROTRACTOR_CACHE_TTL);
      if (deferredResult.ok && deferredResult.deferredWork) {
        protractorDeferredWork = deferredResult.deferredWork;
      }
    }

    const carfaxRecords = (carfaxResult as any).ok ? ((carfaxResult as any).serviceRecords || []) : [];
    
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

    // Customer-name fallback chain — see `lib/plan-build/customer-name.ts`
    // for the priority rules (Tekmetric → Protractor → Shop-Ware → vehicles).
    // We fetch each source lazily (only when prior sources resolved nothing)
    // and pass the raw docs into the pure resolver so the priority +
    // "Unknown Customer" sentinel handling is testable without a live Mongo.
    let tekmetricWorkOrderForName: { customerName?: string | null } | null = null;
    const tekmetricShopId = shopDoc?.tekmetric?.shopId || shopDoc?.tekmetricShopId;
    if (tekmetricShopId) {
      try {
        const cachedWO = await db.collection("tekmetric_work_orders").findOne(
          {
            vin: { $regex: new RegExp(`^${vin}$`, "i") },
            $or: [
              { tekmetricShopId: Number(tekmetricShopId) },
              { tekmetricShopId: String(tekmetricShopId) },
              { shopId: String(shopId) },
              { shopId: Number(shopId) },
            ],
          },
          { sort: { updatedAt: -1, createdAt: -1 }, projection: { workOrderNumber: 1, customerName: 1 } }
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
        const swRo = await db.collection("cached_work_orders").findOne(
          {
            vin: vin.toUpperCase(),
            shopId: { $in: [String(shopId), Number(shopId)] },
            customerName: { $exists: true, $nin: [null, ""] },
          },
          { sort: { createdAt: -1 }, projection: { customerName: 1 } }
        );
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

    const buckets = triage({
      oemItems,
      carfaxRecords,
      shopServiceHistory,
      currentMiles: mileage,
      dviFindings,
      protractorDeferredWork,
      declinedServices,
      soonMiles,
      soonDays,
      milesPerDay: mpdBlended,
      shopIntervals,
      intervalApplyMode,
      vehicleYear,
      vehicleTransType,
      engineRisk,
      oilDutyPreference,
    });

    const isInspectItem = (item: TriagedItem) => {
      // Task #198: keep inspect-only fluid rows (e.g. Mopar's "Inspect
      // transmission fluid") in the plan even when the shop has hidden
      // generic inspect items — they are usually the only OEM signal a
      // customer gets about that fluid, so dropping them silently
      // disappears the row entirely.
      if (item.inspectOnly) return false;
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

    await setCachedPlan(db, vin, shopId, mileage, planData);

    const duration = Date.now() - startTime;
    console.log(`[PlanBuild] Shop ${shopId}: Built and cached plan for ${vin} in ${duration}ms (OEM: ${oemItems.length}, Carfax: ${carfaxRecords.length}, ShopHistory: ${shopServiceHistory.length}, DVI: ${dviFindings.length}, UnresolvedHistory: ${unresolvedHistoricalFindings.length}, Deferred: ${protractorDeferredWork.length})`);

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
    }, { status: 200 });

  } catch (err: any) {
    console.error("[PlanBuild] Error:", err);
    return NextResponse.json(
      { error: "Plan build failed", details: err.message },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json({ error: "Use POST method to build plan" }, { status: 405 });
}
