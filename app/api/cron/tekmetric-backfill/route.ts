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
const MAX_SHOPS_PER_RUN = 1;
const YEARS_TO_BACKFILL = 5;

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

async function tekmetricRequest<T>(endpoint: string, _retries = 3): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const data = await centralTekmetricRequest<T>(endpoint);
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

async function getShopsNeedingBackfill(db: any): Promise<{ shopId: number; name: string; tekmetricShopId: number }[]> {
  // Only fetch shops that don't have the completion flag set
  const shops = await db.collection("shops").find({
    $or: [
      { "tekmetric.shopId": { $exists: true, $ne: null } },
      { "tekmetricShopId": { $exists: true, $ne: null } }
    ],
    tekmetricBackfillComplete: { $ne: true }
  }).toArray();

  const shopsToBackfill: { shopId: number; name: string; tekmetricShopId: number; progressDate: Date | null }[] = [];

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
        progressDate: progress?.currentChunkEnd ? new Date(progress.currentChunkEnd) : null
      });
    }
  }

  // Prioritize: shops with no progress first, then by most recent cursor
  shopsToBackfill.sort((a, b) => {
    if (!a.progressDate && !b.progressDate) return 0;
    if (!a.progressDate) return -1;
    if (!b.progressDate) return 1;
    return b.progressDate.getTime() - a.progressDate.getTime();
  });

  return shopsToBackfill.map(s => ({ shopId: s.shopId, name: s.name, tekmetricShopId: s.tekmetricShopId }));
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
      `/repair-orders?${queryParams}`
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
            const vehResult = await tekmetricRequest<TekmetricVehicle>(`/vehicles/${ro.vehicleId}`);
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
            const custResult = await tekmetricRequest<TekmetricCustomer>(`/customers/${ro.customerId}`);
            if (custResult.ok && custResult.data) {
              customer = custResult.data;
              customerCache.set(ro.customerId, customer);
              await cacheCustomer(db, ro.customerId, custResult.data as any).catch(() => {});
            }
          }
        }
      }

      const jobsResult = await tekmetricRequest<{ content: TekmetricJob[] }>(
        `/jobs?shop=${tekmetricShopId}&repairOrderId=${ro.id}`
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
      if ((hasInspectionUrl || inspectionShared) && backfillXAuthToken) {
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

        const entry = {
          shopId,
          sourceSystem: "tekmetric",
          workOrderId: String(ro.id),
          workOrderNumber: ro.repairOrderNumber,
          servicePackageId: String(job.id),
          jobName: job.name,
          closedAt: ro.postedDate || ro.completedDate || ro.updatedDate,
          vehicle: vehicle ? {
            vin: vehicle.vin,
            year: vehicle.year,
            make: vehicle.make,
            model: vehicle.model,
            engine: vehicle.engine,
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
  //  - On hitting the page cap: only advance halfway, leaving the older half for the next run.
  //  - Otherwise: advance fully to the chunk start.
  let nextChunkEnd: Date;
  let advanceMode: string;
  if (chunkHadError) {
    nextChunkEnd = chunkEnd;
    advanceMode = "HOLD (error in chunk)";
  } else if (hitPageCap) {
    nextChunkEnd = midpoint(chunkStart, chunkEnd);
    advanceMode = `SPLIT (page cap hit, advancing only to ${nextChunkEnd.toISOString().split("T")[0]})`;
  } else {
    nextChunkEnd = chunkStart;
    advanceMode = "FULL";
  }
  const isComplete = !chunkHadError && !hitPageCap && nextChunkEnd <= oldestDate;

  console.log(`[Tekmetric Backfill] Shop ${shopId}: cursor advance ${advanceMode}`);

  await db.collection("tekmetric_backfill_progress").updateOne(
    { shopId },
    {
      $set: {
        currentChunkEnd: nextChunkEnd,
        lastRunAt: new Date(),
        completed: isComplete,
        ...(isComplete ? { completedAt: new Date() } : {}),
        ...(chunkHadError
          ? { lastError: "chunk had errors, holding cursor", lastErrorAt: new Date() }
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

    const selectedShops = shopsToProcess.slice(0, MAX_SHOPS_PER_RUN);
    const results: any[] = [];

    for (const shop of selectedShops) {
      console.log(`[Tekmetric Backfill] Processing: ${shop.name} (Shop ${shop.shopId})`);
      const result = await backfillShopChunk(db, shop.shopId, shop.tekmetricShopId);
      results.push({
        shopId: shop.shopId,
        name: shop.name,
        ...result
      });
    }

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
          return [{ shopId: targetShopId, name: shop.name || `Shop ${targetShopId}`, tekmetricShopId: Number(tekmetricShopId) }];
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
