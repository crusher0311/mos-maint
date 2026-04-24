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
  mileage?: number | null; // Odometer at time of service
  
  vehicle: {
    vin?: string;
    year?: number;
    make?: string;
    model?: string;
    engine?: string;
    mileage?: number | null;
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

export type IndexedVia = "webhook" | "poll" | "backfill" | "reindex";

export type IndexJobsOptions = {
  /**
   * Where this indexing call is being triggered from. Stamped onto each
   * `job_index` doc's `metadata.indexedVia` so we can measure webhook vs
   * polling coverage during the trust-the-webhooks soak period.
   * Defaults to "poll" for backwards compatibility.
   */
  indexedVia?: IndexedVia;
  /**
   * Pre-loaded jobs array (e.g. from a webhook payload). When supplied, we
   * skip both the cache lookup AND the `/jobs` API fallback — meaning a single
   * webhook can produce a fully indexed RO with zero outbound Tekmetric calls.
   */
  preloadedJobs?: TekmetricJobWithDetails[];
};

export async function indexTekmetricWorkOrderJobs(
  shopId: number,
  tekmetricShopId: number,
  workOrderId: number,
  workOrderNumber: number,
  vehicle: { vin?: string; year?: number; make?: string; model?: string; engine?: string },
  completedDate: string,
  mileage?: number | null,
  options?: IndexJobsOptions
): Promise<number> {
  const db = await getDb();
  const jobIndexCollection = db.collection("job_index");
  const indexedVia: IndexedVia = options?.indexedVia ?? "poll";
  
  let indexedCount = 0;
  
  try {
    let jobs: TekmetricJobWithDetails[] = [];
    
    if (options?.preloadedJobs && options.preloadedJobs.length > 0) {
      jobs = options.preloadedJobs;
    } else {
      const cachedWO = await db.collection("tekmetric_work_orders").findOne({
        shopId: { $in: [String(shopId), Number(shopId)] },
        workOrderId: String(workOrderId)
      });
      if (cachedWO?.data?.jobs && cachedWO.data.jobs.length > 0) {
        jobs = cachedWO.data.jobs as TekmetricJobWithDetails[];
      }
    }
    
    if (jobs.length === 0) {
      const jobsResponse = await getJobs(tekmetricShopId, { repairOrderId: workOrderId, size: 100 });
      jobs = (jobsResponse.content || []) as TekmetricJobWithDetails[];
    }

    // Warm the per-RO jobs cache (`tekmetric_jobs_cache`, 30d TTL) for any
    // terminal RO we touch here, regardless of source (webhook, poll, or
    // backfill). Terminal RO job payloads don't change after the fact, so
    // every indexing call is also a free opportunity to warm the cache so
    // a later backfill verification rerun finds it in Mongo instead of
    // paying the `/jobs?repairOrderId=…` API cost. Cache empty arrays too:
    // an indexed RO that genuinely has no jobs is still a stable answer.
    // Soft-fail: indexing is the primary contract, cache warming is a bonus.
    try {
      await db.collection("tekmetric_jobs_cache").updateOne(
        { repairOrderId: workOrderId },
        {
          $set: {
            repairOrderId: workOrderId,
            jobs,
            cachedAt: new Date(),
          },
        },
        { upsert: true }
      );
    } catch (warmErr: any) {
      console.warn(`[Tekmetric Job Index] jobs cache warm failed for RO ${workOrderId}: ${warmErr?.message || warmErr}`);
    }

    if (jobs.length === 0) return 0;
    
    const shopDoc = await db.collection("shops").findOne(
      { shopId: { $in: [String(shopId), Number(shopId)] } },
      { projection: { cachedLaborRate: 1 } }
    );
    const shopLaborRate = shopDoc?.cachedLaborRate || 150;
    
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
        laborHours = laborHours || Math.round(laborAmountDollars / shopLaborRate * 10) / 10;
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
        mileage: mileage ?? null,
        vehicle: { ...vehicle, mileage: mileage ?? null },
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
      };

      // IMPORTANT: use dot-path $set for metadata.* (instead of replacing the
      // whole `metadata` subdocument) so the immutable firstIndexedVia /
      // firstIndexedAt fields written via $setOnInsert on the original insert
      // are preserved across subsequent updates. Replacing `metadata` wholesale
      // would wipe them and reintroduce last-writer-wins distortion.
      const now = new Date();
      await jobIndexCollection.updateOne(
        {
          shopId,
          workOrderId: String(workOrderId),
          servicePackageId: String(job.id)
        },
        {
          $set: {
            ...jobEntry,
            "metadata.indexedAt": now,
            "metadata.sourceType": "tekmetric",
            "metadata.indexedVia": indexedVia,
            "metadata.lastIndexedVia": indexedVia,
          },
          $setOnInsert: {
            "metadata.firstIndexedVia": indexedVia,
            "metadata.firstIndexedAt": now,
          },
        },
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

/**
 * Returns a per-shop, per-day breakdown of `job_index` writes grouped by
 * `metadata.indexedVia`. Powers the soak metric for the trust-the-webhooks
 * migration: lets us see whether webhooks alone would have covered everything
 * polling produced. See TEKMETRIC_5K_SCALING_PLAN.md (Step 2).
 */
export async function getIndexSourceBreakdown(
  daysBack: number = 7
): Promise<Array<{ date: string; shopId: number; indexedVia: string; count: number }>> {
  const db = await getDb();
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

  // Group by `firstIndexedVia` (immutable, set once via $setOnInsert) so the
  // metric reflects who actually produced each row first — webhook vs poll —
  // rather than whoever wrote last. Falls back to `indexedVia` for legacy rows
  // written before the firstIndexedVia field was introduced.
  const rows = await db.collection("job_index").aggregate([
    { $match: { "metadata.indexedAt": { $gte: since }, "metadata.sourceType": "tekmetric" } },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: "%Y-%m-%d", date: { $ifNull: ["$metadata.firstIndexedAt", "$metadata.indexedAt"] } } },
          shopId: "$shopId",
          indexedVia: {
            $ifNull: [
              "$metadata.firstIndexedVia",
              { $ifNull: ["$metadata.indexedVia", "poll"] },
            ],
          },
        },
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        date: "$_id.date",
        shopId: "$_id.shopId",
        indexedVia: "$_id.indexedVia",
        count: 1,
      },
    },
    { $sort: { date: -1, shopId: 1, indexedVia: 1 } },
  ]).toArray();

  return rows as Array<{ date: string; shopId: number; indexedVia: string; count: number }>;
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
        
        const roMileage =
          (typeof ro.milesOut === "number" ? ro.milesOut : null) ??
          (typeof ro.milesIn === "number" ? ro.milesIn : null) ??
          null;

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
          ro.completedDate || ro.updatedDate || ro.createdDate || new Date().toISOString(),
          roMileage,
          { indexedVia: "backfill" }
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

export async function reindexFromStoredData(
  shopId?: number
): Promise<{ rosProcessed: number; jobsReindexed: number }> {
  const db = await getDb();
  const jobIndexCollection = db.collection("job_index");
  
  const query: any = { "data.jobs": { $exists: true } };
  if (shopId) {
    query.shopId = { $in: [String(shopId), Number(shopId)] };
  }
  
  const cursor = db.collection("tekmetric_work_orders").find(query);
  let rosProcessed = 0;
  let jobsReindexed = 0;
  
  const shopRateCache = new Map<number, number>();
  
  while (await cursor.hasNext()) {
    const wo = await cursor.next();
    if (!wo?.data?.jobs || !wo.vin) continue;
    
    const numericShopId = Number(wo.shopId);
    
    if (!shopRateCache.has(numericShopId)) {
      const shopDoc = await db.collection("shops").findOne(
        { shopId: { $in: [String(numericShopId), numericShopId] } },
        { projection: { cachedLaborRate: 1 } }
      );
      shopRateCache.set(numericShopId, shopDoc?.cachedLaborRate || 150);
    }
    const shopLaborRate = shopRateCache.get(numericShopId) || 150;
    
    const jobs = wo.data.jobs as TekmetricJobWithDetails[];
    const vehicle = {
      vin: wo.vin,
      year: wo.vehicleYear,
      make: wo.vehicleMake,
      model: wo.vehicleModel,
      engine: wo.vehicleEngine
    };
    const completedDate = wo.completedDate || wo.updatedDate || wo.createdDate;
    
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
        laborHours = laborHours || Math.round(laborAmountDollars / shopLaborRate * 10) / 10;
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
        shopId: numericShopId,
        workOrderId: String(wo.workOrderId),
        workOrderNumber: wo.workOrderNumber,
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
      };

      // Same dot-path $set discipline as indexTekmetricWorkOrderJobs above:
      // never replace `metadata` wholesale or we'd wipe firstIndexedVia.
      const reindexNow = new Date();
      await jobIndexCollection.updateOne(
        {
          shopId: numericShopId,
          workOrderId: String(wo.workOrderId),
          servicePackageId: String(job.id)
        },
        {
          $set: {
            ...jobEntry,
            "metadata.indexedAt": reindexNow,
            "metadata.sourceType": "tekmetric",
            "metadata.indexedVia": "reindex" as IndexedVia,
            "metadata.lastIndexedVia": "reindex" as IndexedVia,
          },
          $setOnInsert: {
            "metadata.firstIndexedVia": "reindex" as IndexedVia,
            "metadata.firstIndexedAt": reindexNow,
          },
        },
        { upsert: true }
      );
      
      jobsReindexed++;
    }
    
    rosProcessed++;
    if (rosProcessed % 100 === 0) {
      console.log(`[Reindex] Processed ${rosProcessed} ROs, ${jobsReindexed} jobs reindexed`);
    }
  }
  
  console.log(`[Reindex] Complete: ${rosProcessed} ROs, ${jobsReindexed} jobs reindexed`);
  return { rosProcessed, jobsReindexed };
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
