import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import pLimit from "p-limit";
import crypto from "crypto";
import { createIngestionService } from "@/lib/normalized-ingestion";
import { tekmetricRequest as centralTekmetricRequest, resetTekmetricApiCallCount, getRepairOrderInspectionsWithXAuth } from "@/lib/integrations/tekmetric/client";
import { getCachedVehicle, cacheVehicle, getCachedCustomer, cacheCustomer } from "@/lib/tekmetric-incremental-sync";
import { getPaceConfig, midpoint, describePace } from "@/lib/integrations/backfill-pace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;
// Process multiple shops per run to clear the long tail of stalled shops.
// Concurrency is capped per shop in `getPaceConfig` so the global API
// fan-out stays well under the 600 req/min Tekmetric quota.
const MAX_SHOPS_PER_RUN = 5;
const SHOP_PARALLELISM = 3;
const YEARS_TO_BACKFILL = 5;
// If a shop's lastError was set more than this many hours ago, clear it
// before the next run so a transient failure can't permanently freeze the
// cursor without anyone noticing.
const ERROR_AUTO_CLEAR_HOURS = 6;
// If a shop has a lastRunAt but its cursor hasn't moved in this many days,
// flag it as stuck in the diagnostics endpoint.
const STUCK_CURSOR_DAYS = 3;
// If the same chunk window errors this many cron cycles in a row, force
// the cursor past it so one persistently bad window can't permanently
// freeze a shop (e.g. shop 63's "chunk had errors, holding cursor" loop
// where auto-clear flips the error off but the next attempt re-errors
// immediately on the same window).
const MAX_CONSECUTIVE_CHUNK_ERRORS = 3;
// Slot allocation per cron run. Splitting the budget between
// never-started shops and the longest-stalled shops prevents either
// bucket from starving the other. With 19 never-started shops and an
// MAX_SHOPS_PER_RUN of 5, an unsplit budget meant the long-stalled
// (32, 36, 37, ...) bucket waited 4+ runs to even be eligible.
const NEVER_STARTED_SLOTS_PER_RUN = 2;
const STALLED_SLOTS_PER_RUN = 3;

type TekmetricRepairOrder = {
  id: number;
  repairOrderNumber: string;
  vehicleId?: number;
  customerId?: number;
  repairOrderStatus?: { code: string };
  createdDate?: string;
  postedDate?: string;
  completedDate?: string;
  updatedDate?: string;
  milesIn?: number;
  milesOut?: number;
};

type TekmetricJob = {
  id: number;
  name: string;
  laborTotal?: number;
  partsTotal?: number;
  subtotal?: number;
  laborHours?: number;
  labor?: { name: string; hours: number; rate: number }[];
  parts?: { partNumber: string; name: string; brand?: string; quantity: number; retailCost: number }[];
};

type TekmetricVehicle = {
  id: number;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  engine?: string;
};

type TekmetricCustomer = {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
};

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// Wrapper that forwards the MOS shopId for proper per-shop attribution in
// the api_usage tracker. Without this, every backfill call gets bucketed as
// "Shop #null" and we lose visibility into who's burning the Tekmetric quota.
async function tekmetricRequest<T>(endpoint: string, shopId?: number, _retries = 3): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const data = await centralTekmetricRequest<T>(endpoint, {}, shopId);
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

type ShopToBackfill = {
  shopId: number;
  name: string;
  tekmetricShopId: number;
  hasLastRunAt: boolean;
};

async function getShopsNeedingBackfill(db: any): Promise<ShopToBackfill[]> {
  // Only fetch shops that don't have the completion flag set
  const shops = await db.collection("shops").find({
    $or: [
      { "tekmetric.shopId": { $exists: true, $ne: null } },
      { "tekmetricShopId": { $exists: true, $ne: null } }
    ],
    tekmetricBackfillComplete: { $ne: true }
  }).toArray();

  // Auto-recover from held cursors: clear lastError on any shop whose error
  // is older than ERROR_AUTO_CLEAR_HOURS so the next run will retry. Without
  // this, a single bad chunk can hold the cursor indefinitely while the
  // shop stays out of sight.
  const autoClearCutoff = new Date(Date.now() - ERROR_AUTO_CLEAR_HOURS * 60 * 60 * 1000);
  await db.collection("tekmetric_backfill_progress").updateMany(
    { lastError: { $ne: null }, lastErrorAt: { $lt: autoClearCutoff } },
    { $set: { lastError: null, lastErrorAt: null, autoClearedErrorAt: new Date() } }
  );

  const shopsToBackfill: {
    shopId: number;
    name: string;
    tekmetricShopId: number;
    progressDate: Date | null;
    lastRunAt: Date | null;
  }[] = [];

  for (const shop of shops) {
    const shopId = Number(shop.shopId);
    const tekmetricShopId = shop.tekmetric?.shopId || shop.tekmetricShopId;
    if (!tekmetricShopId) continue;

    const progress = await db.collection("tekmetric_backfill_progress").findOne({ shopId });

    // Include shops that are not completed OR have outdated logic version
    const needsReprocess = !progress?.completed || progress?.logicVersion !== 2;

    if (needsReprocess) {
      shopsToBackfill.push({
        shopId,
        name: shop.name || shop.locationIdentifier || `Shop ${shopId}`,
        tekmetricShopId: Number(tekmetricShopId),
        progressDate: progress?.currentChunkEnd ? new Date(progress.currentChunkEnd) : null,
        lastRunAt: progress?.lastRunAt ? new Date(progress.lastRunAt) : null,
      });
    }
  }

  // Fair-queue ordering to prevent starvation:
  //   1. Shops that have NEVER run (lastRunAt missing) go first.
  //   2. Then by oldest lastRunAt — the longest-stalled shop is next up.
  //   3. Tie-break by furthest-from-complete cursor (newer chunkEnd =
  //      less progress made, so prioritize it over a shop that's almost
  //      done and only needs a small final push).
  // The previous implementation sorted un-started shops by *most recent*
  // cursor, which meant freshly-onboarded shops perpetually displaced the
  // long-stalled tail.
  shopsToBackfill.sort((a, b) => {
    if (!a.lastRunAt && b.lastRunAt) return -1;
    if (a.lastRunAt && !b.lastRunAt) return 1;
    if (a.lastRunAt && b.lastRunAt) {
      const diff = a.lastRunAt.getTime() - b.lastRunAt.getTime();
      if (diff !== 0) return diff;
    }
    // Tie-break: shop with the newer (further-from-complete) cursor first.
    const aMs = a.progressDate ? a.progressDate.getTime() : Number.POSITIVE_INFINITY;
    const bMs = b.progressDate ? b.progressDate.getTime() : Number.POSITIVE_INFINITY;
    return bMs - aMs;
  });

  return shopsToBackfill.map(s => ({
    shopId: s.shopId,
    name: s.name,
    tekmetricShopId: s.tekmetricShopId,
    hasLastRunAt: s.lastRunAt != null,
  }));
}

async function backfillShopChunk(
  db: any, 
  shopId: number, 
  tekmetricShopId: number
): Promise<{ jobsIndexed: number; skipped: number; complete: boolean; message: string; normalizedCount: number }> {
  let progress = await db.collection("tekmetric_backfill_progress").findOne({ shopId });
  
  const shop = await db.collection("shops").findOne({ shopId });
  const enterpriseId = shop?.enterpriseId;
  
  const ingestionService = createIngestionService(
    db,
    'tekmetric',
    shopId,
    enterpriseId,
    { 
      syncRunId: `tekmetric-backfill-${Date.now()}`,
      createAuditLog: false,
      dualWriteToJobIndex: true,
      dualWriteToRepairPatterns: true,
    }
  );
  
  // Calculate date boundaries
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  
  const oldestDate = new Date();
  oldestDate.setFullYear(oldestDate.getFullYear() - YEARS_TO_BACKFILL);
  oldestDate.setHours(0, 0, 0, 0);
  
  // REVERSE CHRONOLOGICAL: Start from today, work backwards
  let chunkEnd: Date;
  
  if (progress?.currentChunkEnd && progress?.logicVersion === 2) {
    chunkEnd = new Date(progress.currentChunkEnd);
  } else {
    // Fresh start or upgrading from old logic
    chunkEnd = new Date(today);
    await db.collection("tekmetric_backfill_progress").updateOne(
      { shopId },
      { 
        $set: { 
          shopId, 
          startedAt: new Date(), 
          currentChunkEnd: chunkEnd, 
          completed: false,
          logicVersion: 2
        },
        $unset: { currentChunkStart: "" }
      },
      { upsert: true }
    );
  }

  // Pace config — off-hours boosts concurrency + chunk size
  const pace = getPaceConfig("tekmetric", shop?.timezone, new Date());

  // Calculate chunk start (going backwards)
  const chunkStart = new Date(chunkEnd);
  chunkStart.setDate(chunkStart.getDate() - pace.chunkDays);
  if (chunkStart < oldestDate) {
    chunkStart.setTime(oldestDate.getTime());
  }

  // Check if we've reached the oldest date
  if (chunkEnd <= oldestDate) {
    await db.collection("tekmetric_backfill_progress").updateOne(
      { shopId },
      { $set: { completed: true, completedAt: new Date() } }
    );
    return { jobsIndexed: 0, skipped: 0, complete: true, message: "Already complete", normalizedCount: 0 };
  }

  const startStr = chunkStart.toISOString();
  const endStr = chunkEnd.toISOString();

  console.log(`[Tekmetric Backfill] Shop ${shopId}: ${startStr.split("T")[0]} to ${endStr.split("T")[0]} (reverse) ${describePace(pace)}`);

  let jobsIndexed = 0;
  let skippedUnchanged = 0;
  let page = 0;
  let totalPages = 1;
  let chunkHadError = false;
  let hitPageCap = false;
  const seenROIds = new Set<number>();
  const vehicleCache = new Map<number, TekmetricVehicle>();
  const customerCache = new Map<number, TekmetricCustomer>();
  const limit = pLimit(pace.concurrency);
  const rosForNormalized: any[] = [];

  while (page < totalPages && page < pace.maxPagesPerChunk) {
    const queryParams = new URLSearchParams({
      shop: tekmetricShopId.toString(),
      page: page.toString(),
      size: "100",
      updatedDateStart: startStr,
      updatedDateEnd: endStr,
      sort: "updatedDate",
      sortDirection: "DESC",
    });

    const rosResult = await tekmetricRequest<{ content: TekmetricRepairOrder[]; totalPages: number }>(
      `/repair-orders?${queryParams}`,
      shopId,
    );

    if (!rosResult.ok || !rosResult.data) {
      console.error(`[Tekmetric Backfill] Shop ${shopId} page ${page} error:`, rosResult.error);
      chunkHadError = true;
      break;
    }

    totalPages = rosResult.data.totalPages;
    if (totalPages > pace.maxPagesPerChunk && page + 1 >= pace.maxPagesPerChunk) {
      hitPageCap = true;
    }
    const ros = rosResult.data.content || [];

    console.log(`[Tekmetric Backfill] Shop ${shopId} page ${page + 1}/${totalPages}: ${ros.length} ROs`);

    const roPromises = ros.map(ro => limit(async () => {
      if (seenROIds.has(ro.id)) return { indexed: 0, skipped: 0, roData: null };
      seenROIds.add(ro.id);

      const statusCode = ro.repairOrderStatus?.code?.toUpperCase() || "";
      if (!["POSTED", "INVOICED", "COMPLETED"].includes(statusCode)) {
        return { indexed: 0, skipped: 0, roData: null };
      }

      let vehicle: TekmetricVehicle | null = null;
      if (ro.vehicleId) {
        if (vehicleCache.has(ro.vehicleId)) {
          vehicle = vehicleCache.get(ro.vehicleId)!;
        } else {
          const mongoVehicle = await getCachedVehicle(db, ro.vehicleId);
          if (mongoVehicle) {
            vehicle = mongoVehicle as TekmetricVehicle;
            vehicleCache.set(ro.vehicleId, vehicle);
          } else {
            const vehResult = await tekmetricRequest<TekmetricVehicle>(`/vehicles/${ro.vehicleId}`, shopId);
            if (vehResult.ok && vehResult.data) {
              vehicle = vehResult.data;
              vehicleCache.set(ro.vehicleId, vehicle);
              await cacheVehicle(db, ro.vehicleId, vehResult.data as any).catch(() => {});
            }
          }
        }
      }

      let customer: TekmetricCustomer | null = null;
      if (ro.customerId) {
        if (customerCache.has(ro.customerId)) {
          customer = customerCache.get(ro.customerId)!;
        } else {
          const mongoCustomer = await getCachedCustomer(db, ro.customerId);
          if (mongoCustomer) {
            customer = mongoCustomer as TekmetricCustomer;
            customerCache.set(ro.customerId, customer);
          } else {
            const custResult = await tekmetricRequest<TekmetricCustomer>(`/customers/${ro.customerId}`, shopId);
            if (custResult.ok && custResult.data) {
              customer = custResult.data;
              customerCache.set(ro.customerId, customer);
              await cacheCustomer(db, ro.customerId, custResult.data as any).catch(() => {});
            }
          }
        }
      }

      const jobsResult = await tekmetricRequest<{ content: TekmetricJob[] }>(
        `/jobs?shop=${tekmetricShopId}&repairOrderId=${ro.id}`,
        shopId,
      );

      if (!jobsResult.ok) {
        console.warn(`[Tekmetric Backfill] Failed to fetch jobs for RO ${ro.id}: ${jobsResult.error}`);
        chunkHadError = true;
        return { indexed: 0, skipped: 0, roData: null };
      }

      const jobs = jobsResult.data?.content || [];

      if (jobs.length === 0) return { indexed: 0, skipped: 0, roData: null };

      let inspections: any[] = [];
      const hasInspectionUrl = !!(ro as any).inspectionUrl;
      const inspectionShared = !!(ro as any).inspectionShareDate;
      const backfillXAuthToken = shop?.tekmetric?.xAuthToken || null;
      // Phase C: env-flag gate. Default ON. Flip TEKMETRIC_POLLING_FETCH_INSPECTIONS=false
      // per-env after the Inspection.Complete webhook handler has soaked.
      const pollingFetchEnabled = process.env.TEKMETRIC_POLLING_FETCH_INSPECTIONS !== "false";
      if ((hasInspectionUrl || inspectionShared) && backfillXAuthToken && pollingFetchEnabled) {
        try {
          inspections = await getRepairOrderInspectionsWithXAuth(ro.id, tekmetricShopId, backfillXAuthToken);
        } catch (inspErr: any) {
          console.warn(`[Tekmetric Backfill] Inspection fetch failed for RO ${ro.id}: ${inspErr.message}`);
        }
      }

      let indexed = 0;
      let skipped = 0;
      
      for (const job of jobs) {
        const laborAmountDollars = (job.laborTotal || 0) / 100;
        const partsAmountDollars = (job.partsTotal || 0) / 100;

        const roMileage =
          (typeof ro.milesOut === "number" && ro.milesOut > 0 ? ro.milesOut : null) ??
          (typeof ro.milesIn === "number" && ro.milesIn > 0 ? ro.milesIn : null) ??
          (vehicle && typeof (vehicle as any).mileageOut === "number" && (vehicle as any).mileageOut > 0
            ? (vehicle as any).mileageOut
            : null) ??
          (vehicle && typeof (vehicle as any).mileageIn === "number" && (vehicle as any).mileageIn > 0
            ? (vehicle as any).mileageIn
            : null) ??
          null;

        const entry = {
          shopId,
          sourceSystem: "tekmetric",
          workOrderId: String(ro.id),
          workOrderNumber: ro.repairOrderNumber,
          servicePackageId: String(job.id),
          jobName: job.name,
          closedAt: ro.postedDate || ro.completedDate || ro.updatedDate,
          mileage: roMileage,
          vehicle: vehicle ? {
            vin: vehicle.vin,
            year: vehicle.year,
            make: vehicle.make,
            model: vehicle.model,
            engine: vehicle.engine,
            mileage: roMileage,
          } : null,
          customer: customer ? {
            name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim(),
            email: customer.email,
            phone: customer.phone,
          } : null,
          totalAmount: (job.subtotal || 0) / 100,
          laborAmount: laborAmountDollars,
          partsAmount: partsAmountDollars,
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

        // Compute content hash for change detection
        const contentHash = computeContentHash(entry);
        const filter = { shopId, workOrderId: String(ro.id), servicePackageId: String(job.id) };
        
        // Check if record exists with same hash
        const existing = await db.collection("job_index").findOne(filter);
        
        if (existing && existing.contentHash === contentHash) {
          skipped++;
          continue;
        }

        await db.collection("job_index").updateOne(
          filter,
          { $set: { ...entry, contentHash } },
          { upsert: true }
        );
        indexed++;
      }

      const roDataForNormalized = {
        id: ro.id,
        repairOrderNumber: ro.repairOrderNumber,
        repairOrderStatus: ro.repairOrderStatus?.code || ro.repairOrderStatus,
        postedDate: ro.postedDate,
        completedDate: ro.completedDate,
        createdDate: ro.createdDate,
        updatedDate: ro.updatedDate,
        milesIn: ro.milesIn,
        milesOut: ro.milesOut,
        laborSubtotal: jobs.reduce((sum, j) => sum + (j.laborTotal || 0), 0),
        partsSubtotal: jobs.reduce((sum, j) => sum + (j.partsTotal || 0), 0),
        total: jobs.reduce((sum, j) => sum + (j.subtotal || 0), 0),
        vehicle: vehicle,
        customer: customer,
        jobs: jobs.map(j => ({
          id: j.id,
          name: j.name,
          laborTotal: (j.laborTotal || 0) / 100,
          partsTotal: (j.partsTotal || 0) / 100,
          total: (j.subtotal || 0) / 100,
          laborHours: j.laborHours || 0,
          labor: j.labor,
          parts: j.parts,
        })),
        inspections: inspections.length > 0 ? inspections : [],
        inspectionUrl: (ro as any).inspectionUrl || null,
        inspectionShareDate: (ro as any).inspectionShareDate || null,
        rawPayload: { repairOrder: ro, vehicle, customer, jobs, inspections: inspections.length > 0 ? inspections : undefined },
      };
      
      return { indexed, skipped, roData: roDataForNormalized };
    }));

    const results = await Promise.all(roPromises);
    jobsIndexed += results.reduce((a, b) => a + b.indexed, 0);
    skippedUnchanged += results.reduce((a, b) => a + b.skipped, 0);
    
    for (const r of results) {
      if (r.roData) {
        rosForNormalized.push(r.roData);
      }
    }

    page++;
    await new Promise(r => setTimeout(r, 200));
  }

  // Dual-write to normalized collections
  let normalizedCount = 0;
  try {
    const normalizedResult = await ingestionService.ingestWorkOrderBatchWithAllEntities(rosForNormalized);
    normalizedCount = normalizedResult.workOrders.created + normalizedResult.workOrders.updated;
    console.log(`[Tekmetric Backfill] Shop ${shopId}: Normalized ${normalizedCount} WOs (${normalizedResult.workOrders.created} new), payments: ${normalizedResult.payments.created}, inspections: ${normalizedResult.inspections.created}, recs: ${normalizedResult.recommendations.created}`);
  } catch (normalizedError) {
    console.error(`[Tekmetric Backfill] Shop ${shopId}: Normalized ingestion error:`, normalizedError);
  }

  // Decide cursor advancement strategy:
  //  - On error: do NOT advance; next run retries the same window.
  //    EXCEPT: if this same chunk window has now errored
  //    MAX_CONSECUTIVE_CHUNK_ERRORS times in a row, force-skip past it
  //    so one persistently bad window can't freeze the cursor forever
  //    (auto-clear of `lastError` was insufficient: it just resets the
  //    timestamp, the next attempt re-errors, repeat).
  //  - On hitting the page cap: only advance halfway, leaving the older half for the next run.
  //  - Otherwise: advance fully to the chunk start.
  const priorConsecutiveErrors = (progress?.consecutiveChunkErrors as number) || 0;
  const cursorIsSameWindow =
    !!progress?.currentChunkEnd &&
    new Date(progress.currentChunkEnd).getTime() === chunkEnd.getTime();
  const nextConsecutiveErrors = chunkHadError
    ? (cursorIsSameWindow ? priorConsecutiveErrors + 1 : 1)
    : 0;
  const forceSkipBadWindow =
    chunkHadError && nextConsecutiveErrors >= MAX_CONSECUTIVE_CHUNK_ERRORS;
  let nextChunkEnd: Date;
  let advanceMode: string;
  if (chunkHadError && !forceSkipBadWindow) {
    nextChunkEnd = chunkEnd;
    advanceMode = `HOLD (error in chunk, ${nextConsecutiveErrors}/${MAX_CONSECUTIVE_CHUNK_ERRORS})`;
  } else if (forceSkipBadWindow) {
    nextChunkEnd = chunkStart;
    advanceMode = `FORCE_SKIP (chunk errored ${nextConsecutiveErrors}x in a row, skipping window ${chunkStart.toISOString().split("T")[0]}..${chunkEnd.toISOString().split("T")[0]})`;
    console.warn(
      `[Tekmetric Backfill] FORCE_SKIP shop=${shopId} window=${chunkStart.toISOString().split("T")[0]}..${chunkEnd.toISOString().split("T")[0]} consecutiveErrors=${nextConsecutiveErrors}`,
    );
  } else if (hitPageCap) {
    nextChunkEnd = midpoint(chunkStart, chunkEnd);
    advanceMode = `SPLIT (page cap hit, advancing only to ${nextChunkEnd.toISOString().split("T")[0]})`;
  } else {
    nextChunkEnd = chunkStart;
    advanceMode = "FULL";
  }
  // A force-skipped chunk DID move the cursor — count that as forward
  // progress for the purposes of completion (otherwise a bad final
  // window would leave the shop perpetually one chunk shy of done).
  const isComplete =
    (!chunkHadError || forceSkipBadWindow) && !hitPageCap && nextChunkEnd <= oldestDate;
  // Track actual cursor movement so the sync-health endpoint can report a
  // truthful "frozen for N days" — relying on lastRunAt/lastErrorAt
  // underreports duration for shops that run every night but never advance
  // (recurring-error case).
  const cursorMoved = nextChunkEnd.getTime() !== chunkEnd.getTime();
  const now = new Date();

  console.log(`[Tekmetric Backfill] Shop ${shopId}: cursor advance ${advanceMode}`);

  // Emit a structured warning if the prior cursor-move timestamp is older
  // than STUCK_CURSOR_DAYS and we're STILL not moving the cursor this run.
  // This makes recurring-error stalls visible in the cron logs without
  // requiring anyone to query Mongo.
  if (!cursorMoved && progress?.lastCursorMoveAt) {
    const daysSinceMove = (now.getTime() - new Date(progress.lastCursorMoveAt).getTime()) / (24 * 60 * 60 * 1000);
    if (daysSinceMove > STUCK_CURSOR_DAYS) {
      console.warn(
        `[Tekmetric Backfill] STUCK shop=${shopId} cursorFrozenDays=${daysSinceMove.toFixed(1)} ` +
        `currentChunkEnd=${chunkEnd.toISOString().split("T")[0]} mode=${advanceMode}`
      );
    }
  }

  await db.collection("tekmetric_backfill_progress").updateOne(
    { shopId },
    {
      $set: {
        currentChunkEnd: nextChunkEnd,
        lastRunAt: now,
        completed: isComplete,
        ...(isComplete ? { completedAt: now } : {}),
        ...(cursorMoved
          ? { lastCursorMoveAt: now, previousChunkEnd: chunkEnd }
          : {}),
        consecutiveChunkErrors: nextConsecutiveErrors,
        ...(chunkHadError && !forceSkipBadWindow
          ? { lastError: `chunk had errors, holding cursor (${nextConsecutiveErrors}/${MAX_CONSECUTIVE_CHUNK_ERRORS})`, lastErrorAt: now }
          : forceSkipBadWindow
          ? {
              lastError: `force-skipped bad window after ${nextConsecutiveErrors} consecutive failures`,
              lastErrorAt: now,
              lastForceSkippedWindow: { start: chunkStart, end: chunkEnd, at: now },
            }
          : { lastError: null, lastErrorAt: null }),
      },
      $inc: { totalJobsIndexed: jobsIndexed }
    }
  );

  // Set shop-level completion flag when backfill is done
  if (isComplete) {
    await db.collection("shops").updateOne(
      { shopId },
      { $set: { tekmetricBackfillComplete: true, tekmetricBackfillCompletedAt: new Date() } }
    );
    console.log(`[Tekmetric Backfill] Shop ${shopId}: Marked tekmetricBackfillComplete=true`);
  }

  return {
    jobsIndexed,
    skipped: skippedUnchanged,
    complete: isComplete,
    message: `${startStr.split("T")[0]} to ${endStr.split("T")[0]}: ${jobsIndexed} jobs indexed, ${skippedUnchanged} unchanged, ${normalizedCount} normalized`,
    normalizedCount
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
  resetTekmetricApiCallCount();

  try {
    const shopsToProcess = await getShopsNeedingBackfill(db);

    if (shopsToProcess.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "All Tekmetric shops have completed backfill",
        shopsRemaining: 0,
        duration: `${Date.now() - startTime}ms`
      });
    }

    // Split slot allocation between never-started shops and stalled
    // shops with a lastRunAt. Without this split, a backlog of
    // never-started shops (sorted first by the fair-queue ordering)
    // monopolizes every slot for many runs and starves the
    // long-stalled-with-cursor bucket (the 32/36/37/54/57/73/74/75
    // group). The two buckets are interleaved per run so both make
    // progress.
    const neverStartedQueue = shopsToProcess.filter(s => !s.hasLastRunAt);
    const stalledQueue = shopsToProcess.filter(s => s.hasLastRunAt);
    const selectedNeverStarted = neverStartedQueue.slice(0, NEVER_STARTED_SLOTS_PER_RUN);
    const selectedStalled = stalledQueue.slice(0, STALLED_SLOTS_PER_RUN);
    let selectedShops = [...selectedNeverStarted, ...selectedStalled];
    // If one bucket is short (e.g. all never-started shops have already
    // moved into the stalled bucket), give the remaining slots to the
    // other bucket so we never under-utilize the budget.
    if (selectedShops.length < MAX_SHOPS_PER_RUN) {
      const remaining = MAX_SHOPS_PER_RUN - selectedShops.length;
      const extras = (selectedNeverStarted.length < NEVER_STARTED_SLOTS_PER_RUN
        ? stalledQueue.slice(STALLED_SLOTS_PER_RUN, STALLED_SLOTS_PER_RUN + remaining)
        : neverStartedQueue.slice(NEVER_STARTED_SLOTS_PER_RUN, NEVER_STARTED_SLOTS_PER_RUN + remaining));
      selectedShops = [...selectedShops, ...extras];
    }
    selectedShops = selectedShops.slice(0, MAX_SHOPS_PER_RUN);

    // Process shops in parallel up to SHOP_PARALLELISM. Per-shop concurrency
    // is already throttled by the pace config and the central Tekmetric
    // client tracks the global API budget.
    const shopLimit = pLimit(SHOP_PARALLELISM);
    const results = await Promise.all(
      selectedShops.map(shop =>
        shopLimit(async () => {
          console.log(`[Tekmetric Backfill] Processing: ${shop.name} (Shop ${shop.shopId})`);
          try {
            const result = await backfillShopChunk(db, shop.shopId, shop.tekmetricShopId);
            return { shopId: shop.shopId, name: shop.name, ...result };
          } catch (err: any) {
            console.error(`[Tekmetric Backfill] Shop ${shop.shopId} chunk failed:`, err);
            // CRITICAL: if backfillShopChunk throws (an unwrapped helper
            // like getCachedVehicle, getRepairOrderInspectionsWithXAuth,
            // or normalized ingestion blew up), the inner code never
            // reached the progress write that bumps lastRunAt. Without
            // this safety-net write, the shop keeps its old (or null)
            // lastRunAt and stays at the head of the fair-queue forever
            // — which is exactly how the 19 never-started shops were
            // monopolizing every cron slot and starving the long-stalled
            // bucket (32/36/37/...). Bump lastRunAt and record the error
            // here so the shop rotates out of the queue head and
            // ERROR_AUTO_CLEAR_HOURS can later let it retry.
            const now = new Date();
            const message = (err?.message || String(err)).slice(0, 500);
            try {
              await db.collection("tekmetric_backfill_progress").updateOne(
                { shopId: shop.shopId },
                {
                  $set: {
                    shopId: shop.shopId,
                    lastRunAt: now,
                    lastError: `unhandled chunk exception: ${message}`,
                    lastErrorAt: now,
                  },
                  $setOnInsert: { startedAt: now, completed: false, logicVersion: 2 },
                },
                { upsert: true },
              );
            } catch (writeErr) {
              console.error(`[Tekmetric Backfill] Shop ${shop.shopId} failed to record exception lastRunAt:`, writeErr);
            }
            return {
              shopId: shop.shopId,
              name: shop.name,
              jobsIndexed: 0,
              skipped: 0,
              complete: false,
              normalizedCount: 0,
              message: `error: ${message}`,
            };
          }
        })
      )
    );

    const apiCallCount = resetTekmetricApiCallCount();
    const duration = Date.now() - startTime;
    console.log(`[Cron] Tekmetric backfill completed in ${duration}ms — API calls made: ${apiCallCount} (budget: 600/min)`);

    return NextResponse.json({
      ok: true,
      processed: results,
      shopsRemaining: shopsToProcess.length - selectedShops.length,
      duration: `${duration}ms`,
      tekmetricApiCalls: apiCallCount,
    });

  } catch (err: any) {
    const apiCallCount = resetTekmetricApiCallCount();
    console.error(`[Tekmetric Backfill] Error (API calls made: ${apiCallCount}):`, err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.TEKMETRIC_CLIENT_ID || !process.env.TEKMETRIC_CLIENT_SECRET) {
    return NextResponse.json({ error: "Tekmetric OAuth credentials not configured" }, { status: 500 });
  }

  const db = await getDb();
  const startTime = Date.now();
  resetTekmetricApiCallCount();

  try {
    const body = await req.json().catch(() => ({}));
    const targetShopId = body.shopId ? Number(body.shopId) : null;

    const shopsToProcess = targetShopId
      ? await (async () => {
          const shop = await db.collection("shops").findOne({ shopId: targetShopId });
          if (!shop) return [];
          const tekmetricShopId = shop.tekmetric?.shopId || shop.tekmetricShopId;
          if (!tekmetricShopId) return [];
          return [{ shopId: targetShopId, name: shop.name || `Shop ${targetShopId}`, tekmetricShopId: Number(tekmetricShopId), hasLastRunAt: false }];
        })()
      : await getShopsNeedingBackfill(db);

    if (shopsToProcess.length === 0) {
      return NextResponse.json({ ok: true, message: "No shops to backfill", shopsRemaining: 0 });
    }

    const MAX_CHUNKS = 25;
    const results: any[] = [];

    for (const shop of shopsToProcess) {
      console.log(`[Tekmetric Backfill] Full backfill starting for: ${shop.name} (Shop ${shop.shopId})`);
      let totalJobs = 0;
      let totalSkipped = 0;
      let totalNormalized = 0;
      let chunksProcessed = 0;

      for (let i = 0; i < MAX_CHUNKS; i++) {
        const result = await backfillShopChunk(db, shop.shopId, shop.tekmetricShopId);
        totalJobs += result.jobsIndexed;
        totalSkipped += result.skipped;
        totalNormalized += result.normalizedCount;
        chunksProcessed++;

        console.log(`[Tekmetric Backfill] Shop ${shop.shopId} chunk ${chunksProcessed}: ${result.message}`);

        if (result.complete) {
          console.log(`[Tekmetric Backfill] Shop ${shop.shopId}: COMPLETE after ${chunksProcessed} chunks`);
          break;
        }

        if (Date.now() - startTime > 270000) {
          console.log(`[Tekmetric Backfill] Shop ${shop.shopId}: Approaching timeout after ${chunksProcessed} chunks, will continue next run`);
          break;
        }

        await new Promise(r => setTimeout(r, 500));
      }

      results.push({
        shopId: shop.shopId,
        name: shop.name,
        chunksProcessed,
        totalJobsIndexed: totalJobs,
        totalSkipped,
        totalNormalized,
        complete: chunksProcessed < MAX_CHUNKS,
      });
    }

    const apiCallCount = resetTekmetricApiCallCount();
    const duration = Date.now() - startTime;
    console.log(`[Cron] Tekmetric full backfill completed in ${duration}ms — API calls made: ${apiCallCount} (budget: 600/min)`);

    return NextResponse.json({
      ok: true,
      processed: results,
      duration: `${duration}ms`,
      tekmetricApiCalls: apiCallCount,
    });

  } catch (err: any) {
    const apiCallCount = resetTekmetricApiCallCount();
    console.error(`[Tekmetric Backfill] Full backfill error (API calls made: ${apiCallCount}):`, err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
