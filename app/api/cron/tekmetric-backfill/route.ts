import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import pLimit from "p-limit";
import crypto from "crypto";
import { createIngestionService } from "@/lib/normalized-ingestion";
import { getValidToken } from "@/lib/tekmetric-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;
const TEKMETRIC_API_BASE = "https://shop.tekmetric.com/api/v1";
const MONTHS_PER_RUN = 3;
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

async function tekmetricRequest<T>(endpoint: string, retries = 3): Promise<{ ok: boolean; data?: T; error?: string }> {
  let token: string;
  try {
    token = await getValidToken();
  } catch (err: any) {
    return { ok: false, error: `Token error: ${err.message}` };
  }
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${TEKMETRIC_API_BASE}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        cache: "no-store",
      });
      
      if (res.status === 429) {
        const backoffMs = Math.min(Math.pow(2, attempt + 1) * 1000 + Math.random() * 1000, 60000);
        console.log(`[Tekmetric] Rate limited, backing off ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1})`);
        await sleep(backoffMs);
        continue;
      }
      
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      
      return { ok: true, data: await res.json() };
    } catch (err: any) {
      if (attempt < retries) {
        const backoffMs = Math.pow(2, attempt + 1) * 1000 + Math.random() * 1000;
        await sleep(backoffMs);
        continue;
      }
      return { ok: false, error: err.message };
    }
  }
  
  return { ok: false, error: "Max retries exceeded" };
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

  // Calculate chunk start (going backwards)
  const chunkStart = new Date(chunkEnd);
  chunkStart.setMonth(chunkStart.getMonth() - MONTHS_PER_RUN);
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

  console.log(`[Tekmetric Backfill] Shop ${shopId}: ${startStr.split("T")[0]} to ${endStr.split("T")[0]} (reverse chronological)`);

  let jobsIndexed = 0;
  let skippedUnchanged = 0;
  let page = 0;
  let totalPages = 1;
  const seenROIds = new Set<number>();
  const vehicleCache = new Map<number, TekmetricVehicle>();
  const customerCache = new Map<number, TekmetricCustomer>();
  const limit = pLimit(8);
  const rosForNormalized: any[] = [];

  while (page < totalPages && page < 50) {
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
      break;
    }

    totalPages = rosResult.data.totalPages;
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
          const vehResult = await tekmetricRequest<TekmetricVehicle>(`/vehicles/${ro.vehicleId}`);
          if (vehResult.ok && vehResult.data) {
            vehicle = vehResult.data;
            vehicleCache.set(ro.vehicleId, vehicle);
          }
        }
      }

      let customer: TekmetricCustomer | null = null;
      if (ro.customerId) {
        if (customerCache.has(ro.customerId)) {
          customer = customerCache.get(ro.customerId)!;
        } else {
          const custResult = await tekmetricRequest<TekmetricCustomer>(`/customers/${ro.customerId}`);
          if (custResult.ok && custResult.data) {
            customer = custResult.data;
            customerCache.set(ro.customerId, customer);
          }
        }
      }

      const jobsResult = await tekmetricRequest<{ content: TekmetricJob[] }>(
        `/jobs?shop=${tekmetricShopId}&repairOrderId=${ro.id}`
      );
      const jobs = jobsResult.data?.content || [];

      if (jobs.length === 0) return { indexed: 0, skipped: 0 };

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
        rawPayload: { repairOrder: ro, vehicle, customer, jobs },
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
    await new Promise(r => setTimeout(r, 100));
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

  // Move cursor backwards for next run
  const nextChunkEnd = chunkStart;
  const isComplete = nextChunkEnd <= oldestDate;

  await db.collection("tekmetric_backfill_progress").updateOne(
    { shopId },
    {
      $set: {
        currentChunkEnd: nextChunkEnd,
        lastRunAt: new Date(),
        completed: isComplete,
        ...(isComplete ? { completedAt: new Date() } : {}),
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

    return NextResponse.json({
      ok: true,
      processed: results,
      shopsRemaining: shopsToProcess.length - selectedShops.length,
      duration: `${Date.now() - startTime}ms`
    });

  } catch (err: any) {
    console.error("[Tekmetric Backfill] Error:", err);
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

    return NextResponse.json({
      ok: true,
      processed: results,
      duration: `${Date.now() - startTime}ms`
    });

  } catch (err: any) {
    console.error("[Tekmetric Backfill] Full backfill error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
