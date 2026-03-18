import { getDb } from "@/lib/mongo";
import { getJobs, getVehicle, getRepairOrders } from "@/lib/tekmetric";

type TekmetricJobWithDetails = {
  id: number;
  repairOrderId: number;
  name: string;
  authorized: boolean;
  laborTotal?: number;
  laborAmount?: number;
  partsTotal?: number;
  partsAmount?: number;
  discountTotal?: number;
  discountAmount?: number;
  subtotal?: number;
  totalAmount?: number;
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
  const db = await getDb();
  const jobIndexCollection = db.collection("job_index");
  
  let indexedCount = 0;
  
  try {
    const jobsResponse = await getJobs(tekmetricShopId, { repairOrderId: workOrderId, size: 100 });
    const jobs = (jobsResponse.content || []) as TekmetricJobWithDetails[];
    
    if (jobs.length === 0) return 0;
    
    for (const job of jobs) {
      if (!job.name) continue;
      
      const laborAmountDollars = (job.laborTotal || job.laborAmount || 0) / 100;
      const partsAmountDollars = (job.partsTotal || job.partsAmount || 0) / 100;
      const totalAmountDollars = (job.subtotal || job.totalAmount || 0) / 100;
      
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
        const allPartsZero = job.parts.every(p => !(p.retail || p.cost));
        const totalPartsQty = job.parts.reduce((s, p) => s + (p.quantity || 1), 0);
        for (const part of job.parts) {
          const qty = part.quantity || 1;
          let retailDollars = (part.retail || part.cost || 0) / 100;
          if (retailDollars === 0 && allPartsZero && partsAmountDollars > 0 && totalPartsQty > 0) {
            retailDollars = Math.round((partsAmountDollars / totalPartsQty) * 100) / 100;
          }
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
      
      const jobEntry: TekmetricJobIndexEntry = {
        shopId,
        workOrderId: String(workOrderId),
        workOrderNumber,
        servicePackageId: String(job.id),
        performedAt: new Date(completedDate || new Date()),
        vehicle,
        job: {
          title: job.name,
          keywords: extractKeywords(job.name)
        },
        lines,
        totals: {
          laborHours,
          laborAmount: laborAmountDollars,
          partsAmount: partsAmountDollars,
          totalAmount: totalAmountDollars || (laborAmountDollars + partsAmountDollars)
        },
        metadata: {
          indexedAt: new Date(),
          sourceType: "tekmetric"
        }
      };
      
      await jobIndexCollection.updateOne(
        {
          shopId,
          workOrderId: String(workOrderId),
          servicePackageId: String(job.id)
        },
        { $set: jobEntry },
        { upsert: true }
      );
      
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
  
  const db = await getDb();
  const jobIndexCollection = db.collection("job_index");
  
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
      
      await db.collection("shops").updateOne(
        { shopId: { $in: [shopId, String(shopId)] } },
        { $set: { "tekmetric.jobIndexBackfillLastPage": page } }
      );
      
      if (page > 100) {
        console.log("[Tekmetric Backfill] Reached page limit");
        break;
      }
      
    } catch (err: any) {
      console.error(`[Tekmetric Backfill] Error on page ${page}: ${err.message}`);
      await db.collection("shops").updateOne(
        { shopId: { $in: [shopId, String(shopId)] } },
        { 
          $set: { 
            "tekmetric.jobIndexBackfillError": err.message,
            "tekmetric.jobIndexBackfillErrorAt": new Date()
          },
          $unset: { "tekmetric.jobIndexBackfillStartedAt": "" }
        }
      );
      throw err;
    }
  }
  
  await db.collection("shops").updateOne(
    { shopId: { $in: [shopId, String(shopId)] } },
    { 
      $set: { "tekmetric.jobIndexBackfillCompleted": new Date() },
      $unset: { 
        "tekmetric.jobIndexBackfillStartedAt": "",
        "tekmetric.jobIndexBackfillError": "",
        "tekmetric.jobIndexBackfillErrorAt": ""
      }
    }
  );
  
  console.log(`[Tekmetric Backfill] Complete: ${rosProcessed} ROs, ${jobsIndexed} jobs indexed`);
  
  return { rosProcessed, jobsIndexed };
}

export async function checkAndRunBackfillForNewShops(): Promise<void> {
  const db = await getDb();
  
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  
  const shops = await db.collection("shops").find({
    $and: [
      {
        $or: [
          { "tekmetric.shopId": { $exists: true, $ne: null } },
          { tekmetricShopId: { $exists: true, $ne: null } }
        ]
      },
      { "tekmetric.jobIndexBackfillCompleted": { $exists: false } },
      {
        $or: [
          { "tekmetric.jobIndexBackfillStartedAt": { $exists: false } },
          { "tekmetric.jobIndexBackfillStartedAt": { $lt: oneHourAgo } }
        ]
      }
    ]
  }).toArray();
  
  for (const shop of shops) {
    const shopId = Number(shop.shopId);
    const tekmetricShopId = shop.tekmetric?.shopId || shop.tekmetricShopId;
    
    if (!tekmetricShopId) continue;
    
    console.log(`[Tekmetric] New shop ${shopId} detected, starting 5-year backfill...`);
    
    await db.collection("shops").updateOne(
      { shopId: { $in: [shopId, String(shopId)] } },
      { $set: { "tekmetric.jobIndexBackfillStartedAt": new Date() } }
    );
    
    try {
      await runTekmetricHistoryBackfill(shopId, tekmetricShopId, 5);
    } catch (err: any) {
      console.error(`[Tekmetric] Backfill failed for shop ${shopId}: ${err.message}`);
    }
  }
}
