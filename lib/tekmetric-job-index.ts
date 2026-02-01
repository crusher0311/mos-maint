import sql from "@/lib/db/postgres";
import { getJobs, getVehicle, getRepairOrders } from "@/lib/tekmetric";

type TekmetricJobWithDetails = {
  id: number;
  repairOrderId: number;
  name: string;
  authorized: boolean;
  laborTotal?: number;
  partsTotal?: number;
  discountTotal?: number;
  subtotal?: number;
  laborHours?: number;
  labor?: Array<{
    id: number;
    name?: string;
    hours?: number;
    rate?: number;
  }>;
  parts?: Array<{
    id: number;
    partNumber?: string;
    name?: string;
    description?: string;
    quantity?: number;
    cost?: number;
    retail?: number;
    brand?: string;
  }>;
};

export type TekmetricJobIndexEntry = {
  shopId: number;
  workOrderId: string;
  workOrderNumber: number;
  servicePackageId: string;
  performedAt: Date;
  
  vehicle: {
    vin?: string;
    year?: number;
    make?: string;
    model?: string;
    engine?: string;
  };
  
  job: {
    title: string;
    description?: string;
    keywords: string[];
  };
  
  lines: Array<{
    lineType: "labor" | "part" | "sublet" | "other";
    description: string;
    partNumber?: string;
    manufacturer?: string;
    quantity: number;
    unitPrice: number;
    extendedPrice: number;
    hours?: number;
  }>;
  
  totals: {
    laborHours: number;
    laborAmount: number;
    partsAmount: number;
    totalAmount: number;
  };
  
  metadata: {
    indexedAt: Date;
    sourceType: "tekmetric";
  };
};

function extractKeywords(title: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "was", "are", "were", "been",
    "be", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "must", "shall", "can", "need",
    "service", "package", "job", "work", "order"
  ]);
  
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
  
  return [...new Set(words)];
}

export async function indexTekmetricWorkOrderJobs(
  shopId: number,
  tekmetricShopId: number,
  workOrderId: number,
  workOrderNumber: number,
  vehicle: { vin?: string; year?: number; make?: string; model?: string; engine?: string },
  completedDate: string
): Promise<number> {
  const shopIdStr = String(shopId);
  
  let indexedCount = 0;
  
  try {
    const jobsResponse = await getJobs(tekmetricShopId, { repairOrderId: workOrderId, size: 100 });
    const jobs = (jobsResponse.content || []) as TekmetricJobWithDetails[];
    
    if (jobs.length === 0) return 0;
    
    for (const job of jobs) {
      if (!job.name) continue;
      
      const laborAmountDollars = (job.laborTotal || 0) / 100;
      const partsAmountDollars = (job.partsTotal || 0) / 100;
      const totalAmountDollars = (job.subtotal || 0) / 100;
      
      const lines: TekmetricJobIndexEntry["lines"] = [];
      let laborHours = job.laborHours || 0;
      
      if (job.labor && job.labor.length > 0) {
        for (const entry of job.labor) {
          const hours = entry.hours || 0;
          const rateDollars = (entry.rate || 0) / 100;
          lines.push({
            lineType: "labor",
            description: entry.name || job.name,
            quantity: 1,
            unitPrice: rateDollars,
            extendedPrice: hours * rateDollars,
            hours
          });
        }
      } else if (laborAmountDollars > 0) {
        laborHours = laborHours || Math.round(laborAmountDollars / 150 * 10) / 10;
        lines.push({
          lineType: "labor",
          description: job.name,
          quantity: 1,
          unitPrice: laborAmountDollars,
          extendedPrice: laborAmountDollars,
          hours: laborHours
        });
      }
      
      if (job.parts && job.parts.length > 0) {
        for (const part of job.parts) {
          const qty = part.quantity || 1;
          const retailDollars = (part.retail || part.cost || 0) / 100;
          lines.push({
            lineType: "part",
            description: part.name || part.description || "",
            partNumber: part.partNumber,
            manufacturer: part.brand,
            quantity: qty,
            unitPrice: retailDollars,
            extendedPrice: qty * retailDollars
          });
        }
      } else if (partsAmountDollars > 0) {
        lines.push({
          lineType: "part",
          description: "Parts",
          quantity: 1,
          unitPrice: partsAmountDollars,
          extendedPrice: partsAmountDollars
        });
      }
      
      const keywords = extractKeywords(job.name);
      const totals = {
        laborHours,
        laborAmount: laborAmountDollars,
        partsAmount: partsAmountDollars,
        totalAmount: totalAmountDollars || (laborAmountDollars + partsAmountDollars)
      };
      
      const jobData = {
        title: job.name,
        keywords,
      };
      
      await sql`
        INSERT INTO job_index (
          shop_id, vin, work_order_id, job_title, job_label, keywords,
          vehicle_make, vehicle_model, vehicle_year,
          labor_amount, parts_amount, total_amount, labor_hours,
          performed_at, job, lines, totals, created_at
        )
        SELECT 
          s.id,
          ${vehicle.vin?.toUpperCase() || null},
          ${String(workOrderId)},
          ${job.name},
          ${String(job.id)},
          ${keywords},
          ${vehicle.make || null},
          ${vehicle.model || null},
          ${vehicle.year || null},
          ${laborAmountDollars},
          ${partsAmountDollars},
          ${totals.totalAmount},
          ${laborHours},
          ${completedDate}::timestamp,
          ${JSON.stringify(jobData)}::jsonb,
          ${JSON.stringify(lines)}::jsonb,
          ${JSON.stringify(totals)}::jsonb,
          NOW()
        FROM shops s
        WHERE s.shop_id = ${shopIdStr}
        ON CONFLICT (shop_id, work_order_id, job_label) 
        DO UPDATE SET
          job_title = EXCLUDED.job_title,
          keywords = EXCLUDED.keywords,
          vehicle_make = EXCLUDED.vehicle_make,
          vehicle_model = EXCLUDED.vehicle_model,
          vehicle_year = EXCLUDED.vehicle_year,
          labor_amount = EXCLUDED.labor_amount,
          parts_amount = EXCLUDED.parts_amount,
          total_amount = EXCLUDED.total_amount,
          labor_hours = EXCLUDED.labor_hours,
          performed_at = EXCLUDED.performed_at,
          job = EXCLUDED.job,
          lines = EXCLUDED.lines,
          totals = EXCLUDED.totals
      `;
      
      indexedCount++;
    }
    
  } catch (err: any) {
    console.log(`[Tekmetric Job Index] Error indexing jobs for WO ${workOrderId}: ${err.message}`);
    throw err;
  }
  
  return indexedCount;
}

export async function runTekmetricHistoryBackfill(
  shopId: number,
  tekmetricShopId: number,
  yearsBack: number = 5
): Promise<{ rosProcessed: number; jobsIndexed: number }> {
  console.log(`[Tekmetric Backfill] Starting for shop ${shopId} (Tekmetric: ${tekmetricShopId}), ${yearsBack} years back`);
  
  const shopIdStr = String(shopId);
  
  const endDate = new Date();
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - yearsBack);
  
  const startDateStr = startDate.toISOString();
  const endDateStr = endDate.toISOString();
  
  let rosProcessed = 0;
  let jobsIndexed = 0;
  let page = 0;
  let hasMore = true;
  
  const vehicleCache = new Map<number, any>();
  
  while (hasMore) {
    try {
      const response = await getRepairOrders(tekmetricShopId, {
        page,
        size: 100,
        updatedDateStart: startDateStr,
        updatedDateEnd: endDateStr,
        sortDirection: "DESC"
      });
      
      console.log(`[Tekmetric Backfill] Page ${page + 1}/${response.totalPages}: ${response.content.length} ROs`);
      
      for (const ro of response.content) {
        const statusCode = (ro.repairOrderStatus?.code || "").toUpperCase();
        if (!["POSTED", "INVOICED", "INVOICE"].includes(statusCode)) {
          continue;
        }
        
        if (!ro.vehicleId) continue;
        
        let vehicle = vehicleCache.get(ro.vehicleId);
        if (!vehicle) {
          try {
            vehicle = await getVehicle(ro.vehicleId);
            vehicleCache.set(ro.vehicleId, vehicle);
          } catch {
            continue;
          }
        }
        
        if (!vehicle?.vin) continue;
        
        rosProcessed++;
        
        const indexed = await indexTekmetricWorkOrderJobs(
          shopId,
          tekmetricShopId,
          ro.id,
          ro.repairOrderNumber,
          {
            vin: vehicle.vin,
            year: vehicle.year,
            make: vehicle.make,
            model: vehicle.model,
            engine: vehicle.engine
          },
          ro.completedDate || ro.updatedDate || ro.createdDate || new Date().toISOString()
        );
        
        jobsIndexed += indexed;
        
        await new Promise(r => setTimeout(r, 50));
      }
      
      hasMore = !response.last;
      page++;
      
      await sql`
        UPDATE shops
        SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('tekmetric', COALESCE(settings->'tekmetric', '{}'::jsonb) || jsonb_build_object('jobIndexBackfillLastPage', ${page}))
        WHERE shop_id = ${shopIdStr}
      `;
      
      if (page > 100) {
        console.log("[Tekmetric Backfill] Reached page limit");
        break;
      }
      
    } catch (err: any) {
      console.error(`[Tekmetric Backfill] Error on page ${page}: ${err.message}`);
      await sql`
        UPDATE shops
        SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
          'tekmetric', COALESCE(settings->'tekmetric', '{}'::jsonb) || jsonb_build_object(
            'jobIndexBackfillError', ${err.message},
            'jobIndexBackfillErrorAt', ${new Date().toISOString()}
          )
        )
        WHERE shop_id = ${shopIdStr}
      `;
      throw err;
    }
  }
  
  await sql`
    UPDATE shops
    SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
      'tekmetric', COALESCE(settings->'tekmetric', '{}'::jsonb) || jsonb_build_object(
        'jobIndexBackfillCompleted', ${new Date().toISOString()}
      ) - 'jobIndexBackfillStartedAt' - 'jobIndexBackfillError' - 'jobIndexBackfillErrorAt'
    )
    WHERE shop_id = ${shopIdStr}
  `;
  
  console.log(`[Tekmetric Backfill] Complete: ${rosProcessed} ROs, ${jobsIndexed} jobs indexed`);
  
  return { rosProcessed, jobsIndexed };
}

export async function checkAndRunBackfillForNewShops(): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  
  const rows = await sql`
    SELECT shop_id, tekmetric_shop_id, settings
    FROM shops
    WHERE (tekmetric_shop_id IS NOT NULL OR settings->'tekmetric'->>'shopId' IS NOT NULL)
      AND (settings->'tekmetric'->>'jobIndexBackfillCompleted') IS NULL
      AND (
        (settings->'tekmetric'->>'jobIndexBackfillStartedAt') IS NULL
        OR (settings->'tekmetric'->>'jobIndexBackfillStartedAt')::timestamp < ${oneHourAgo}
      )
  `;
  
  for (const shop of rows) {
    const shopId = Number(shop.shop_id);
    const settings = shop.settings as Record<string, any> | null;
    const tekmetricShopId = shop.tekmetric_shop_id || settings?.tekmetric?.shopId;
    
    if (!tekmetricShopId) continue;
    
    console.log(`[Tekmetric] New shop ${shopId} detected, starting 5-year backfill...`);
    
    await sql`
      UPDATE shops
      SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
        'tekmetric', COALESCE(settings->'tekmetric', '{}'::jsonb) || jsonb_build_object(
          'jobIndexBackfillStartedAt', ${new Date().toISOString()}
        )
      )
      WHERE shop_id = ${String(shopId)}
    `;
    
    try {
      await runTekmetricHistoryBackfill(shopId, tekmetricShopId, 5);
    } catch (err: any) {
      console.error(`[Tekmetric] Backfill failed for shop ${shopId}: ${err.message}`);
    }
  }
}
