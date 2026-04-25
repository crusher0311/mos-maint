import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import crypto from "crypto";
import { createIngestionService } from "@/lib/normalized-ingestion";
import {
  tekmetricRequest as centralTekmetricRequest,
  runWithTekmetricApiCallTracking,
  getRepairOrderInspectionsWithXAuth,
} from "@/lib/integrations/tekmetric/client";
import { MAX_RETRY_ATTEMPTS } from "@/lib/integrations/tekmetric/ro-retry-constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

const MAX_SHOPS_PER_RUN = 10;
const MAX_ROS_PER_SHOP = 10;
const MAX_TOTAL_ROS = 50;
const RECOVERED_HISTORY_CAP = 25;

type SkippedSample = {
  roId: number;
  error?: string | null;
  at?: Date | string | null;
  retryAttempts?: number;
  lastRetryAt?: Date | string | null;
  lastRetryError?: string | null;
  permanentlyFailed?: boolean;
};

type TekmetricRepairOrder = {
  id: number;
  repairOrderNumber: string;
  vehicleId?: number;
  customerId?: number;
  repairOrderStatus?: { code: string } | string;
  createdDate?: string;
  postedDate?: string;
  completedDate?: string;
  updatedDate?: string;
  milesIn?: number;
  milesOut?: number;
  inspectionUrl?: string | null;
  inspectionShareDate?: string | null;
};

type TekmetricJob = {
  id: number;
  name: string;
  laborTotal?: number;
  partsTotal?: number;
  subtotal?: number;
  laborHours?: number;
  labor?: any[];
  parts?: { partNumber: string; name: string; brand?: string; quantity: number; retailCost: number }[];
};

function computeContentHash(entry: any): string {
  const hashContent = {
    workOrderId: entry.workOrderId,
    servicePackageId: entry.servicePackageId,
    vehicle: entry.vehicle,
    jobName: entry.jobName,
    lines: entry.lines,
    totalAmount: entry.totalAmount,
    laborAmount: entry.laborAmount,
    partsAmount: entry.partsAmount,
    laborHours: entry.laborHours,
  };
  return crypto.createHash("sha256").update(JSON.stringify(hashContent)).digest("hex").slice(0, 16);
}

async function tekmetricGet<T>(endpoint: string, shopId?: number): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const data = await centralTekmetricRequest<T>(endpoint, {}, shopId);
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function fetchAndIndexSingleRo(
  db: any,
  shop: any,
  shopId: number,
  tekmetricShopId: number,
  roId: number,
): Promise<{ ok: true; jobsIndexed: number } | { ok: false; error: string }> {
  const roResult = await tekmetricGet<TekmetricRepairOrder>(`/repair-orders/${roId}`, shopId);
  if (!roResult.ok || !roResult.data) {
    return { ok: false, error: roResult.error || "RO fetch failed" };
  }
  const ro = roResult.data;

  const statusCodeRaw =
    typeof ro.repairOrderStatus === "string"
      ? ro.repairOrderStatus
      : ro.repairOrderStatus?.code;
  const statusCode = (statusCodeRaw || "").toUpperCase();
  if (!["POSTED", "INVOICED", "COMPLETED"].includes(statusCode)) {
    // Non-final RO — treat as recovered (nothing to index) so it's removed
    // from the skipped list rather than retried forever.
    return { ok: true, jobsIndexed: 0 };
  }

  let vehicle: any = null;
  if (ro.vehicleId) {
    const v = await tekmetricGet<any>(`/vehicles/${ro.vehicleId}`, shopId);
    if (v.ok && v.data) vehicle = v.data;
  }

  let customer: any = null;
  if (ro.customerId) {
    const c = await tekmetricGet<any>(`/customers/${ro.customerId}`, shopId);
    if (c.ok && c.data) customer = c.data;
  }

  const jobsResult = await tekmetricGet<{ content: TekmetricJob[] }>(
    `/jobs?shop=${tekmetricShopId}&repairOrderId=${ro.id}`,
    shopId,
  );
  if (!jobsResult.ok) {
    return { ok: false, error: `jobs fetch: ${jobsResult.error}` };
  }
  const jobs = jobsResult.data?.content || [];

  let inspections: any[] = [];
  const xAuthToken = shop?.tekmetric?.xAuthToken || null;
  const pollingFetchEnabled = process.env.TEKMETRIC_POLLING_FETCH_INSPECTIONS !== "false";
  if ((ro.inspectionUrl || ro.inspectionShareDate) && xAuthToken && pollingFetchEnabled) {
    try {
      inspections = await getRepairOrderInspectionsWithXAuth(ro.id, tekmetricShopId, xAuthToken);
    } catch {
      // non-fatal; proceed without inspections
    }
  }

  const roMileage =
    (typeof ro.milesOut === "number" && ro.milesOut > 0 ? ro.milesOut : null) ??
    (typeof ro.milesIn === "number" && ro.milesIn > 0 ? ro.milesIn : null) ??
    (vehicle && typeof vehicle.mileageOut === "number" && vehicle.mileageOut > 0 ? vehicle.mileageOut : null) ??
    (vehicle && typeof vehicle.mileageIn === "number" && vehicle.mileageIn > 0 ? vehicle.mileageIn : null) ??
    null;

  let jobsIndexed = 0;
  for (const job of jobs) {
    const entry: any = {
      shopId,
      sourceSystem: "tekmetric",
      workOrderId: String(ro.id),
      workOrderNumber: ro.repairOrderNumber,
      servicePackageId: String(job.id),
      jobName: job.name,
      closedAt: ro.postedDate || ro.completedDate || ro.updatedDate,
      mileage: roMileage,
      vehicle: vehicle
        ? {
            vin: vehicle.vin,
            year: vehicle.year,
            make: vehicle.make,
            model: vehicle.model,
            engine: vehicle.engine,
            mileage: roMileage,
          }
        : null,
      customer: customer
        ? {
            name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim(),
            email: customer.email,
            phone: customer.phone,
          }
        : null,
      totalAmount: (job.subtotal || 0) / 100,
      laborAmount: (job.laborTotal || 0) / 100,
      partsAmount: (job.partsTotal || 0) / 100,
      laborHours: job.laborHours || 0,
      lines: [] as any[],
      indexedAt: new Date(),
    };
    if (job.parts?.length) {
      for (const part of job.parts) {
        entry.lines.push({
          lineType: "part",
          partNumber: part.partNumber,
          description: part.name,
          manufacturer: part.brand,
          quantity: part.quantity || 1,
          unitPrice: (part.retailCost || 0) / 100,
          extendedPrice: ((part.quantity || 1) * (part.retailCost || 0)) / 100,
        });
      }
    }
    const contentHash = computeContentHash(entry);
    const filter = { shopId, workOrderId: String(ro.id), servicePackageId: String(job.id) };
    const existing = await db.collection("job_index").findOne(filter);
    if (existing && existing.contentHash === contentHash) continue;
    await db.collection("job_index").updateOne(
      filter,
      { $set: { ...entry, contentHash } },
      { upsert: true },
    );
    jobsIndexed++;
  }

  // Normalized dual-write
  try {
    const ingestionService = createIngestionService(db, "tekmetric", shopId, shop?.enterpriseId, {
      syncRunId: `tekmetric-ro-retry-${Date.now()}`,
      createAuditLog: false,
      dualWriteToJobIndex: true,
      dualWriteToRepairPatterns: true,
    });
    const roDataForNormalized = {
      id: ro.id,
      repairOrderNumber: ro.repairOrderNumber,
      repairOrderStatus: statusCode,
      postedDate: ro.postedDate,
      completedDate: ro.completedDate,
      createdDate: ro.createdDate,
      updatedDate: ro.updatedDate,
      milesIn: ro.milesIn,
      milesOut: ro.milesOut,
      laborSubtotal: jobs.reduce((s, j) => s + (j.laborTotal || 0), 0),
      partsSubtotal: jobs.reduce((s, j) => s + (j.partsTotal || 0), 0),
      total: jobs.reduce((s, j) => s + (j.subtotal || 0), 0),
      vehicle,
      customer,
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        laborTotal: (j.laborTotal || 0) / 100,
        partsTotal: (j.partsTotal || 0) / 100,
        total: (j.subtotal || 0) / 100,
        laborHours: j.laborHours || 0,
        labor: j.labor,
        parts: j.parts,
      })),
      inspections,
      inspectionUrl: ro.inspectionUrl || null,
      inspectionShareDate: ro.inspectionShareDate || null,
      rawPayload: { repairOrder: ro, vehicle, customer, jobs, inspections },
    };
    await ingestionService.ingestWorkOrderBatchWithAllEntities([roDataForNormalized]);
  } catch (normErr: any) {
    console.warn(
      `[Tekmetric RO Retry] Shop ${shopId} RO ${roId}: normalized ingest failed: ${normErr?.message || normErr}`,
    );
  }

  return { ok: true, jobsIndexed };
}

type PerRoResult = {
  roId: number;
  status: "recovered" | "still_failing" | "permanently_failed";
  attempts: number;
  jobsIndexed?: number;
  error?: string;
};

type ProcessShopResult = {
  attempted: number;
  recovered: number;
  stillFailing: number;
  permanentlyFailed: number;
  perRo: PerRoResult[];
  reason?: string;
};

async function processShop(
  db: any,
  progressRow: any,
  budgetRemaining: number,
  options?: { maxRos?: number },
): Promise<ProcessShopResult> {
  const shopId = Number(progressRow.shopId);
  const shop = await db.collection("shops").findOne({ shopId });
  if (!shop) {
    return { attempted: 0, recovered: 0, stillFailing: 0, permanentlyFailed: 0, perRo: [], reason: "shop_not_found" };
  }
  const tekmetricShopId = Number(shop.tekmetric?.shopId || shop.tekmetricShopId);
  if (!tekmetricShopId) {
    return { attempted: 0, recovered: 0, stillFailing: 0, permanentlyFailed: 0, perRo: [], reason: "no_tekmetric_shop_id" };
  }

  const skipped: SkippedSample[] = Array.isArray(progressRow.recentSkippedRos)
    ? progressRow.recentSkippedRos
    : [];
  // Skip rows whose RO is already permanently failed.
  const maxRos = options?.maxRos ?? MAX_ROS_PER_SHOP;
  const candidates = skipped
    .filter((s) => !s.permanentlyFailed && (s.retryAttempts || 0) < MAX_RETRY_ATTEMPTS)
    .slice(0, Math.min(maxRos, budgetRemaining));

  if (candidates.length === 0) {
    return { attempted: 0, recovered: 0, stillFailing: 0, permanentlyFailed: 0, perRo: [], reason: "no_eligible_ros" };
  }

  const recoveredIds = new Set<number>();
  const failureUpdates = new Map<number, { error: string; attempts: number; permanent: boolean }>();
  const perRo: PerRoResult[] = [];
  let recovered = 0;
  let stillFailing = 0;
  let permanentlyFailed = 0;

  for (const sample of candidates) {
    const result = await fetchAndIndexSingleRo(db, shop, shopId, tekmetricShopId, sample.roId);
    if (result.ok) {
      recoveredIds.add(sample.roId);
      recovered++;
      perRo.push({
        roId: sample.roId,
        status: "recovered",
        attempts: (sample.retryAttempts || 0) + 1,
        jobsIndexed: result.jobsIndexed,
      });
    } else {
      const attempts = (sample.retryAttempts || 0) + 1;
      const permanent = attempts >= MAX_RETRY_ATTEMPTS;
      const errMsg = (result.error || "").slice(0, 300);
      failureUpdates.set(sample.roId, {
        error: errMsg,
        attempts,
        permanent,
      });
      if (permanent) permanentlyFailed++;
      else stillFailing++;
      perRo.push({
        roId: sample.roId,
        status: permanent ? "permanently_failed" : "still_failing",
        attempts,
        error: errMsg,
      });
    }
    // tiny breather between ROs
    await new Promise((r) => setTimeout(r, 100));
  }

  // Build the new recentSkippedRos list: drop recovered, update failures.
  const now = new Date();
  const nextSkipped: SkippedSample[] = [];
  for (const s of skipped) {
    if (recoveredIds.has(s.roId)) continue;
    const upd = failureUpdates.get(s.roId);
    if (upd) {
      nextSkipped.push({
        ...s,
        retryAttempts: upd.attempts,
        lastRetryAt: now,
        lastRetryError: upd.error,
        permanentlyFailed: upd.permanent || s.permanentlyFailed === true,
      });
    } else {
      nextSkipped.push(s);
    }
  }

  const recoveredEntries = Array.from(recoveredIds).map((roId) => ({ roId, recoveredAt: now }));
  // Whether any non-permanent skipped ROs still remain. If everything is
  // recovered or permanently parked, clear the consecutive-runs counter so
  // sync-health stops flagging the shop as "recurring RO skips".
  const hasActiveFailures = nextSkipped.some(
    (s) => !s.permanentlyFailed && (s.retryAttempts || 0) < MAX_RETRY_ATTEMPTS,
  );

  const setOps: any = {
    recentSkippedRos: nextSkipped,
    lastRoRetryAt: now,
    lastRoRetryRecovered: recovered,
    lastRoRetryStillFailing: stillFailing,
    lastRoRetryPermanentlyFailed: permanentlyFailed,
  };
  if (!hasActiveFailures) {
    setOps.consecutiveRoSkipRuns = 0;
  }

  const updateDoc: any = {
    $set: setOps,
    $inc: {
      recoveredRoCount: recovered,
      permanentlyFailedRoCount: permanentlyFailed,
    },
  };
  if (recoveredEntries.length > 0) {
    updateDoc.$push = {
      recoveredRos: {
        $each: recoveredEntries,
        $slice: -RECOVERED_HISTORY_CAP,
      },
    };
  }

  await db.collection("tekmetric_backfill_progress").updateOne({ shopId }, updateDoc);

  console.log(
    `[Tekmetric RO Retry] Shop ${shopId}: attempted=${candidates.length} recovered=${recovered} stillFailing=${stillFailing} permanentlyFailed=${permanentlyFailed}`,
  );

  return {
    attempted: candidates.length,
    recovered,
    stillFailing,
    permanentlyFailed,
    perRo,
  };
}

export async function retryShopSkippedRos(
  db: any,
  shopId: number,
  options?: { maxRos?: number },
): Promise<ProcessShopResult & { shopId: number }> {
  const progressRow = await db
    .collection("tekmetric_backfill_progress")
    .findOne({ shopId });
  if (!progressRow) {
    return {
      shopId,
      attempted: 0,
      recovered: 0,
      stillFailing: 0,
      permanentlyFailed: 0,
      perRo: [],
      reason: "no_progress_row",
    };
  }
  const budget = options?.maxRos ?? MAX_ROS_PER_SHOP;
  const result = await processShop(db, progressRow, budget, options);
  return { shopId, ...result };
}

export async function runRetry(db: any) {
  // Pull progress rows that have any non-permanent skipped ROs to retry.
  const rows = await db
    .collection("tekmetric_backfill_progress")
    .find({ "recentSkippedRos.0": { $exists: true } })
    .toArray();

  // Filter to rows with at least one retry-eligible RO.
  const eligible = rows.filter((r: any) =>
    Array.isArray(r.recentSkippedRos) &&
    r.recentSkippedRos.some(
      (s: any) => !s.permanentlyFailed && (s.retryAttempts || 0) < MAX_RETRY_ATTEMPTS,
    ),
  );

  // Process oldest-retried first so no shop is starved.
  eligible.sort((a: any, b: any) => {
    const at = a.lastRoRetryAt ? new Date(a.lastRoRetryAt).getTime() : 0;
    const bt = b.lastRoRetryAt ? new Date(b.lastRoRetryAt).getTime() : 0;
    return at - bt;
  });

  const selected = eligible.slice(0, MAX_SHOPS_PER_RUN);
  let totalAttempted = 0;
  let totalRecovered = 0;
  let totalStillFailing = 0;
  let totalPermanentlyFailed = 0;
  const perShop: any[] = [];

  let budgetRemaining = MAX_TOTAL_ROS;
  for (const row of selected) {
    if (budgetRemaining <= 0) break;
    const r = await processShop(db, row, budgetRemaining);
    totalAttempted += r.attempted;
    totalRecovered += r.recovered;
    totalStillFailing += r.stillFailing;
    totalPermanentlyFailed += r.permanentlyFailed;
    budgetRemaining -= r.attempted;
    if (r.attempted > 0) perShop.push({ shopId: row.shopId, ...r });
  }

  return {
    shopsConsidered: eligible.length,
    shopsProcessed: perShop.length,
    totalAttempted,
    totalRecovered,
    totalStillFailing,
    totalPermanentlyFailed,
    perShop,
  };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.TEKMETRIC_CLIENT_ID || !process.env.TEKMETRIC_CLIENT_SECRET) {
    return NextResponse.json({ error: "Tekmetric OAuth credentials not configured" }, { status: 500 });
  }

  const db = await getDb();
  const startTime = Date.now();

  // Wrap the whole retry cycle in an AsyncLocalStorage scope so the
  // API-call count we report is *this* run's calls only — not leaked
  // from any other concurrent Tekmetric operation in the same Node
  // process (e.g. a backfill cron tick or admin-triggered retry).
  return runWithTekmetricApiCallTracking(async (apiCallCounter) => {
    try {
      const summary = await runRetry(db);
      const apiCalls = apiCallCounter.count;
      const duration = Date.now() - startTime;
      console.log(
        `[Cron] Tekmetric RO retry: ${summary.totalRecovered} recovered, ${summary.totalStillFailing} still failing, ${summary.totalPermanentlyFailed} permanently failed (API calls: ${apiCalls}, ${duration}ms)`,
      );
      return NextResponse.json({ ok: true, ...summary, tekmetricApiCalls: apiCalls, duration: `${duration}ms` });
    } catch (err: any) {
      const apiCalls = apiCallCounter.count;
      console.error("[Tekmetric RO Retry] Error:", err);
      return NextResponse.json({ error: err.message, tekmetricApiCalls: apiCalls }, { status: 500 });
    }
  });
}

export async function POST(req: NextRequest) {
  // Same handler — allow on-demand POST trigger from admin UI.
  return GET(req);
}
