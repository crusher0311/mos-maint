import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import pLimit from "p-limit";
import crypto from "crypto";
import { NormalizedIngestionServicePg } from "@/lib/normalized-ingestion-pg";
import { getValidToken } from "@/lib/tekmetric-auth";
import { acquireAdvisoryLock, releaseAdvisoryLock, generateLockKey } from "@/lib/backfill-locks";
import { getHotStartDateRange, completeHotStart, getHotStartStatus } from "@/lib/hot-start";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;
const TEKMETRIC_API_BASE = "https://shop.tekmetric.com/api/v1";
const MONTHS_PER_RUN = 3;
const MAX_SHOPS_PER_RUN = 3; // Increased for parallel processing
const YEARS_TO_BACKFILL = 5;
const HOT_START_DAYS = 30;

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

async function getShopsNeedingBackfill(): Promise<{ shopId: number; name: string; tekmetricShopId: number; needsHotStart: boolean }[]> {
  const shops = await sql`
    SELECT * FROM shops 
    WHERE (tekmetric->>'shopId' IS NOT NULL OR tekmetric_shop_id IS NOT NULL)
      AND (tekmetric_backfill_complete IS NULL OR tekmetric_backfill_complete = FALSE)
  `;

  const shopsToBackfill: { shopId: number; name: string; tekmetricShopId: number; progressDate: Date | null; needsHotStart: boolean }[] = [];

  for (const shop of shops as any[]) {
    const shopId = Number(shop.shop_id);
    const tekmetricShopId = shop.tekmetric?.shopId || shop.tekmetric_shop_id;
    if (!tekmetricShopId) continue;
    
    const progressRows = await sql`SELECT * FROM tekmetric_backfill_progress WHERE shop_id = ${String(shopId)}`;
    const progress = progressRows[0] as any;
    
    const needsReprocess = !progress?.completed || progress?.logic_version !== 2;
    const needsHotStart = !shop.hot_start_completed;
    
    if (needsReprocess) {
      shopsToBackfill.push({
        shopId,
        name: shop.name || shop.location_identifier || `Shop ${shopId}`,
        tekmetricShopId: Number(tekmetricShopId),
        progressDate: progress?.current_chunk_end ? new Date(progress.current_chunk_end) : null,
        needsHotStart,
      });
    }
  }

  // Prioritize hot-start shops first, then by progress date
  shopsToBackfill.sort((a, b) => {
    // Hot-start shops first
    if (a.needsHotStart && !b.needsHotStart) return -1;
    if (!a.needsHotStart && b.needsHotStart) return 1;
    
    // Then by progress date
    if (!a.progressDate && !b.progressDate) return 0;
    if (!a.progressDate) return -1;
    if (!b.progressDate) return 1;
    return b.progressDate.getTime() - a.progressDate.getTime();
  });

  return shopsToBackfill.map(s => ({ 
    shopId: s.shopId, 
    name: s.name, 
    tekmetricShopId: s.tekmetricShopId,
    needsHotStart: s.needsHotStart,
  }));
}

async function backfillShopChunk(
  shopId: number, 
  tekmetricShopId: number,
  isHotStart: boolean = false
): Promise<{ jobsIndexed: number; skipped: number; complete: boolean; message: string; normalizedCount: number; phase: string }> {
  const progressRows = await sql`SELECT * FROM tekmetric_backfill_progress WHERE shop_id = ${String(shopId)}`;
  let progress = progressRows[0] as any;
  
  const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${String(shopId)}`;
  const shop = shopRows[0] as any;
  const enterpriseId = shop?.enterprise_id;
  
  const ingestionService = new NormalizedIngestionServicePg(
    'tekmetric',
    shopId,
    enterpriseId,
    { 
      syncRunId: `tekmetric-backfill-${Date.now()}`,
      createAuditLog: false,
      dualWriteToJobIndex: false,
      dualWriteToRepairPatterns: true,
    }
  );
  
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  
  // For hot-start: only go back 30 days, then we're done with hot-start phase
  // For historical: go back YEARS_TO_BACKFILL years
  const oldestDate = new Date();
  if (isHotStart) {
    oldestDate.setDate(oldestDate.getDate() - HOT_START_DAYS);
  } else {
    oldestDate.setFullYear(oldestDate.getFullYear() - YEARS_TO_BACKFILL);
  }
  oldestDate.setHours(0, 0, 0, 0);
  
  let chunkEnd: Date;
  const phase = isHotStart ? 'hot_start' : 'historical';
  
  if (progress?.current_chunk_end && progress?.logic_version === 2 && progress?.phase === phase) {
    chunkEnd = new Date(progress.current_chunk_end);
  } else {
    chunkEnd = new Date(today);
    await sql`
      INSERT INTO tekmetric_backfill_progress (shop_id, started_at, current_chunk_end, completed, logic_version, phase, updated_at)
      VALUES (${String(shopId)}, NOW(), ${chunkEnd.toISOString()}, FALSE, 2, ${phase}, NOW())
      ON CONFLICT (shop_id) DO UPDATE SET
        started_at = NOW(),
        current_chunk_end = EXCLUDED.current_chunk_end,
        completed = FALSE,
        logic_version = 2,
        phase = EXCLUDED.phase,
        updated_at = NOW()
    `;
  }

  // For hot-start, use larger chunk (entire 30 days in one go)
  const chunkStart = new Date(chunkEnd);
  if (isHotStart) {
    chunkStart.setDate(chunkStart.getDate() - HOT_START_DAYS);
  } else {
    chunkStart.setMonth(chunkStart.getMonth() - MONTHS_PER_RUN);
  }
  if (chunkStart < oldestDate) {
    chunkStart.setTime(oldestDate.getTime());
  }

  if (chunkEnd <= oldestDate) {
    await sql`
      UPDATE tekmetric_backfill_progress SET completed = TRUE, completed_at = NOW(), phase = ${phase}, updated_at = NOW()
      WHERE shop_id = ${String(shopId)}
    `;
    return { jobsIndexed: 0, skipped: 0, complete: true, message: "Already complete", normalizedCount: 0, phase };
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

        const contentHash = computeContentHash(entry);
        
        const existingRows = await sql`
          SELECT content_hash FROM job_index 
          WHERE shop_id = ${String(shopId)} AND work_order_id = ${String(ro.id)} AND service_package_id = ${String(job.id)}
        `;
        const existing = existingRows[0] as any;
        
        if (existing && existing.content_hash === contentHash) {
          skipped++;
          continue;
        }

        await sql`
          INSERT INTO job_index (shop_id, source_system, work_order_id, work_order_number, service_package_id, job_name,
            closed_at, vehicle, customer, total_amount, labor_amount, parts_amount, labor_hours, lines, indexed_at, content_hash,
            created_at, updated_at)
          VALUES (
            ${String(shopId)}, 'tekmetric', ${String(ro.id)}, ${ro.repairOrderNumber}, ${String(job.id)}, ${job.name},
            ${entry.closedAt ?? null}, ${JSON.stringify(entry.vehicle)}::jsonb, ${JSON.stringify(entry.customer)}::jsonb,
            ${entry.totalAmount}, ${entry.laborAmount}, ${entry.partsAmount}, ${entry.laborHours},
            ${JSON.stringify(entry.lines)}::jsonb, NOW(), ${contentHash}, NOW(), NOW()
          )
          ON CONFLICT (shop_id, work_order_id, service_package_id) DO UPDATE SET
            job_name = EXCLUDED.job_name,
            closed_at = EXCLUDED.closed_at,
            vehicle = EXCLUDED.vehicle,
            customer = EXCLUDED.customer,
            total_amount = EXCLUDED.total_amount,
            labor_amount = EXCLUDED.labor_amount,
            parts_amount = EXCLUDED.parts_amount,
            labor_hours = EXCLUDED.labor_hours,
            lines = EXCLUDED.lines,
            indexed_at = NOW(),
            content_hash = EXCLUDED.content_hash,
            updated_at = NOW()
        `;
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

  let normalizedCount = 0;
  try {
    const normalizedResult = await ingestionService.ingestWorkOrderBatchWithAllEntities(rosForNormalized);
    normalizedCount = normalizedResult.workOrders.created + normalizedResult.workOrders.updated;
    console.log(`[Tekmetric Backfill] Shop ${shopId}: Normalized ${normalizedCount} WOs (${normalizedResult.workOrders.created} new), payments: ${normalizedResult.payments.created}, inspections: ${normalizedResult.inspections.created}, recs: ${normalizedResult.recommendations.created}`);
  } catch (normalizedError) {
    console.error(`[Tekmetric Backfill] Shop ${shopId}: Normalized ingestion error:`, normalizedError);
  }

  const nextChunkEnd = chunkStart;
  const isComplete = nextChunkEnd <= oldestDate;

  await sql`
    UPDATE tekmetric_backfill_progress SET
      current_chunk_end = ${nextChunkEnd.toISOString()},
      last_run_at = NOW(),
      completed = ${isComplete},
      completed_at = ${isComplete ? new Date().toISOString() : null},
      total_jobs_indexed = COALESCE(total_jobs_indexed, 0) + ${jobsIndexed},
      updated_at = NOW()
    WHERE shop_id = ${String(shopId)}
  `;

  if (isComplete) {
    await sql`
      UPDATE shops SET
        tekmetric_backfill_complete = TRUE,
        tekmetric_backfill_completed_at = NOW(),
        updated_at = NOW()
      WHERE shop_id = ${String(shopId)}
    `;
    console.log(`[Tekmetric Backfill] Shop ${shopId}: Marked tekmetricBackfillComplete=true`);
  }

  return {
    jobsIndexed,
    skipped: skippedUnchanged,
    complete: isComplete,
    message: `${startStr.split("T")[0]} to ${endStr.split("T")[0]}: ${jobsIndexed} jobs indexed, ${skippedUnchanged} unchanged, ${normalizedCount} normalized`,
    normalizedCount,
    phase,
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

  const startTime = Date.now();

  try {
    const shopsToProcess = await getShopsNeedingBackfill();

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
    const skipped: any[] = [];

    // Process shops in parallel with advisory locks
    const parallelLimit = pLimit(MAX_SHOPS_PER_RUN);
    
    const processShop = async (shop: typeof selectedShops[0]) => {
      const lockKey = generateLockKey(String(shop.shopId), 'tekmetric-backfill');
      const acquired = await acquireAdvisoryLock(lockKey);
      
      if (!acquired) {
        console.log(`[Tekmetric Backfill] Shop ${shop.shopId} already being processed, skipping`);
        return { shop, skipped: true };
      }
      
      try {
        const phase = shop.needsHotStart ? 'hot_start' : 'historical';
        console.log(`[Tekmetric Backfill] Processing: ${shop.name} (Shop ${shop.shopId}) [${phase}]`);
        
        const result = await backfillShopChunk(shop.shopId, shop.tekmetricShopId, shop.needsHotStart);
        
        // If this was a hot-start shop and we've processed at least some data, mark it complete
        if (shop.needsHotStart && result.jobsIndexed > 0) {
          await completeHotStart(String(shop.shopId));
          console.log(`[Tekmetric Backfill] Hot-start completed for shop ${shop.shopId}`);
        }
        
        return { shop, result, skipped: false };
      } finally {
        await releaseAdvisoryLock(lockKey);
      }
    };

    const processResults = await Promise.all(
      selectedShops.map(shop => parallelLimit(() => processShop(shop)))
    );

    for (const pr of processResults) {
      if (pr.skipped) {
        skipped.push({ shopId: pr.shop.shopId, name: pr.shop.name, reason: 'already_processing' });
      } else if (pr.result) {
        results.push({
          shopId: pr.shop.shopId,
          name: pr.shop.name,
          hotStart: pr.shop.needsHotStart,
          ...pr.result
        });
      }
    }

    return NextResponse.json({
      ok: true,
      processed: results,
      skipped,
      shopsRemaining: shopsToProcess.length - selectedShops.length,
      duration: `${Date.now() - startTime}ms`
    });

  } catch (err: any) {
    console.error("[Tekmetric Backfill] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
