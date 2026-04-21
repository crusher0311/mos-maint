// lib/job-index.ts
// Job Lookup / Parts Intelligence - Data Indexing Layer

import { getDb } from "@/lib/mongo";
import crypto from "crypto";

// Compute a deterministic hash of job entry content for change detection
export function computeJobHash(entry: JobIndexEntry): string {
  // Only hash the content that matters for equality (exclude metadata.indexedAt)
  const hashContent = {
    workOrderId: entry.workOrderId,
    servicePackageId: entry.servicePackageId,
    vehicle: entry.vehicle,
    job: entry.job,
    lines: entry.lines,
    totals: entry.totals,
  };
  return crypto.createHash("sha256").update(JSON.stringify(hashContent)).digest("hex").slice(0, 16);
}

export type JobIndexEntry = {
  shopId: number;
  workOrderId: string;
  workOrderNumber?: number;
  servicePackageId: string;
  performedAt: Date;
  isDeferred?: boolean; // True if this was deferred/declined work (not completed)
  mileage?: number | null; // Odometer reading at time of service (top-level for fast access)
  
  vehicle: {
    vin?: string;
    year?: number;
    make?: string;
    model?: string;
    engine?: string;
    serviceItemId?: string;
    mileage?: number | null;
  };
  
  job: {
    title: string;
    description?: string;
    code?: string;
    chapter?: string;
    keywords: string[];
  };
  
  lines: JobLineItem[];
  
  totals: {
    laborHours: number;
    laborAmount: number;
    partsAmount: number;
    totalAmount: number;
  };
  
  metadata: {
    indexedAt: Date;
    sourceType: "protractor" | "tekmetric" | "autoflow";
  };
};

export type JobLineItem = {
  lineType: "labor" | "part" | "sublet" | "other";
  description: string;
  partNumber?: string;
  manufacturer?: string;
  quantity: number;
  unitPrice: number;
  extendedPrice: number;
};

export type PartCrossRef = {
  shopId: number;
  partNumber: string;
  normalizedPartNumber: string;
  description: string;
  manufacturer?: string;
  
  usedOn: {
    year: number;
    make: string;
    model: string;
    engine?: string;
  }[];
  
  crossReferences: {
    partNumber: string;
    manufacturer?: string;
    usageCount: number;
    confidence: number;
  }[];
  
  workOrderIds: string[];
  usageCount: number;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

function normalizeLineType(lineType?: string): JobLineItem["lineType"] {
  if (!lineType) return "labor";
  const normalized = lineType.toLowerCase();
  
  if (normalized.includes("labor")) return "labor";
  if (normalized.includes("part") || normalized.includes("material")) return "part";
  if (normalized.includes("sublet")) return "sublet";
  return "other";
}

function extractKeywords(title: string, description?: string): string[] {
  const text = `${title || ""} ${description || ""}`.toLowerCase();
  
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "was", "are", "were", "been",
    "be", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "must", "shall", "can", "need",
    "service", "package", "job", "work", "order"
  ]);
  
  const words = text
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
  
  return [...new Set(words)];
}

function normalizePartNumber(partNumber: string): string {
  return partNumber
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function extractJobIndexFromWorkOrder(
  shopId: number,
  workOrder: any,
  sourceType: "protractor" | "tekmetric" | "autoflow" = "protractor"
): JobIndexEntry[] {
  const entries: JobIndexEntry[] = [];
  
  const vehicle = workOrder.ServiceItem || workOrder.vehicle || {};
  const servicePackages = workOrder.ServicePackages?.ItemCollection || 
                          workOrder.ServicePackages || 
                          [];
  
  // Also capture DeferredServicePackages - these are declined/recommended services with pricing
  const deferredPackages = workOrder.DeferredServicePackages?.ItemCollection || 
                           workOrder.DeferredServicePackages || 
                           [];
  
  // Combine both completed and deferred packages for indexing
  const allPackages = [
    ...(Array.isArray(servicePackages) ? servicePackages.map(p => ({ ...p, _isDeferred: false })) : []),
    ...(Array.isArray(deferredPackages) ? deferredPackages.map(p => ({ ...p, _isDeferred: true })) : []),
  ];
  
  if (allPackages.length === 0) {
    return entries;
  }
  
  const performedAt = workOrder.Header?.LastModifiedTime || 
                      workOrder.Header?.CreationTime || 
                      workOrder.completedAt ||
                      new Date();
  
  for (const pkg of allPackages) {
    const title = pkg.ServicePackageHeader?.Title || pkg.Title || pkg.title || "";
    const description = pkg.ServicePackageHeader?.Description || pkg.Description || pkg.description || "";
    const isDeferred = pkg._isDeferred === true;
    
    if (!title) continue;
    
    const lines: JobLineItem[] = [];
    let laborHours = 0;
    let laborAmount = 0;
    let partsAmount = 0;
    let totalAmount = 0;
    
    const packageLines = pkg.ServicePackageLines?.ItemCollection || 
                         pkg.ServicePackageLines || 
                         pkg.lines || 
                         [];
    
    if (Array.isArray(packageLines)) {
      for (const line of packageLines) {
        const lineType = normalizeLineType(line.Type || line.LineType || line.lineType);
        const quantity = parseFloat(line.Quantity || line.quantity || "1") || 1;
        
        // Handle Protractor's nested PriceSummary structure and flat fields
        const priceSummary = line.PriceSummary || {};
        const unitPrice = parseFloat(
          priceSummary.SellPrice || 
          line.Price || 
          line.UnitPrice || 
          line.unitPrice || 
          "0"
        ) || 0;
        const extendedPrice = parseFloat(
          priceSummary.SellTotal || 
          priceSummary.SellSubtotal ||
          line.ExtendedPrice || 
          line.ExtendedTotal || 
          line.Total || 
          line.total || 
          "0"
        ) || (quantity * unitPrice);
        
        lines.push({
          lineType,
          description: line.Description || line.description || "",
          partNumber: line.PartNumber || line.partNumber || undefined,
          manufacturer: line.Manufacturer || line.manufacturer || undefined,
          quantity,
          unitPrice,
          extendedPrice,
        });
        
        if (lineType === "labor") {
          // Check for explicit hours field first, only fallback to quantity if no hours specified
          const hoursValue = line.EstimatedHours ?? line.Hours ?? null;
          const hours = hoursValue !== null ? (parseFloat(hoursValue) || 0) : quantity;
          laborHours += hours;
          laborAmount += extendedPrice;
        } else if (lineType === "part") {
          partsAmount += extendedPrice;
        }
        totalAmount += extendedPrice;
      }
    }
    
    if (lines.length === 0) continue;
    
    // Capture odometer at time of service. Field names vary by source system:
    //   Protractor: OutUsage / InUsage / Odometer (top-level on workOrder)
    //   Tekmetric (when adapted into this shape): milesOut / milesIn
    //   Generic: odometer / mileage on the vehicle sub-doc
    const woMileage =
      (typeof workOrder.OutUsage === "number" && workOrder.OutUsage > 0 ? workOrder.OutUsage : null) ??
      (typeof workOrder.InUsage === "number" && workOrder.InUsage > 0 ? workOrder.InUsage : null) ??
      (typeof workOrder.Odometer === "number" && workOrder.Odometer > 0 ? workOrder.Odometer : null) ??
      (typeof workOrder.milesOut === "number" && workOrder.milesOut > 0 ? workOrder.milesOut : null) ??
      (typeof workOrder.milesIn === "number" && workOrder.milesIn > 0 ? workOrder.milesIn : null) ??
      (typeof workOrder.odometer === "number" && workOrder.odometer > 0 ? workOrder.odometer : null) ??
      (typeof vehicle.Mileage === "number" && vehicle.Mileage > 0 ? vehicle.Mileage : null) ??
      (typeof vehicle.mileage === "number" && vehicle.mileage > 0 ? vehicle.mileage : null) ??
      null;

    entries.push({
      shopId,
      workOrderId: workOrder.ID || workOrder.id,
      workOrderNumber: workOrder.WorkOrderNumber || workOrder.workOrderNumber,
      servicePackageId: pkg.ID || pkg.id,
      performedAt: new Date(performedAt),
      isDeferred, // Track if this was deferred/declined work
      mileage: woMileage,
      
      vehicle: {
        vin: vehicle.VIN || vehicle.vin,
        year: vehicle.Year || vehicle.year,
        make: vehicle.Make || vehicle.make,
        model: vehicle.Model || vehicle.model,
        engine: vehicle.Engine || vehicle.engine,
        serviceItemId: vehicle.ID || vehicle.id,
        mileage: woMileage,
      },
      
      job: {
        title,
        description,
        code: pkg.Code || pkg.code,
        chapter: pkg.Chapter || pkg.chapter,
        keywords: extractKeywords(title, description),
      },
      
      lines,
      
      totals: {
        laborHours,
        laborAmount,
        partsAmount,
        totalAmount,
      },
      
      metadata: {
        indexedAt: new Date(),
        sourceType,
      },
    });
  }
  
  return entries;
}

export function extractJobIndexFromCachedWorkOrder(
  shopId: number,
  cachedWO: any,
  vehicleData?: any
): JobIndexEntry[] {
  const entries: JobIndexEntry[] = [];
  
  const servicePackages = cachedWO.servicePackages?.ItemCollection || 
                          cachedWO.servicePackages || 
                          [];
  
  if (!Array.isArray(servicePackages) || servicePackages.length === 0) {
    return entries;
  }
  
  const performedAt = cachedWO.fetchedAt || cachedWO.scheduledTime || new Date();
  
  for (const pkg of servicePackages) {
    const title = pkg.ServicePackageHeader?.Title || pkg.Title || pkg.title || "";
    const description = pkg.ServicePackageHeader?.Description || pkg.Description || pkg.description || "";
    
    if (!title) continue;
    
    const lines: JobLineItem[] = [];
    let laborHours = 0;
    let laborAmount = 0;
    let partsAmount = 0;
    let totalAmount = 0;
    
    const packageLines = pkg.ServicePackageLines?.ItemCollection || 
                         pkg.ServicePackageLines || 
                         pkg.lines || 
                         [];
    
    if (Array.isArray(packageLines)) {
      for (const line of packageLines) {
        const lineType = normalizeLineType(line.Type || line.LineType || line.lineType);
        const quantity = parseFloat(line.Quantity || line.quantity || "1") || 1;
        
        // Handle Protractor's nested PriceSummary structure and flat fields
        const priceSummary = line.PriceSummary || {};
        const unitPrice = parseFloat(
          priceSummary.SellPrice || 
          line.Price || 
          line.UnitPrice || 
          line.unitPrice || 
          "0"
        ) || 0;
        const extendedPrice = parseFloat(
          priceSummary.SellTotal || 
          priceSummary.SellSubtotal ||
          line.ExtendedPrice || 
          line.ExtendedTotal || 
          line.Total || 
          line.total || 
          "0"
        ) || (quantity * unitPrice);
        
        lines.push({
          lineType,
          description: line.Description || line.description || "",
          partNumber: line.PartNumber || line.partNumber || undefined,
          manufacturer: line.Manufacturer || line.manufacturer || undefined,
          quantity,
          unitPrice,
          extendedPrice,
        });
        
        if (lineType === "labor") {
          // Check for explicit hours field first, only fallback to quantity if no hours specified
          const hoursValue = line.EstimatedHours ?? line.Hours ?? null;
          const hours = hoursValue !== null ? (parseFloat(hoursValue) || 0) : quantity;
          laborHours += hours;
          laborAmount += extendedPrice;
        } else if (lineType === "part") {
          partsAmount += extendedPrice;
        }
        totalAmount += extendedPrice;
      }
    }
    
    if (lines.length === 0) continue;
    
    entries.push({
      shopId,
      workOrderId: cachedWO.workOrderId || cachedWO.ID,
      workOrderNumber: cachedWO.workOrderNumber,
      servicePackageId: pkg.ID || pkg.id || `${cachedWO.workOrderId}-${entries.length}`,
      performedAt: new Date(performedAt),
      
      vehicle: {
        vin: cachedWO.vin,
        year: vehicleData?.year || vehicleData?.Year,
        make: vehicleData?.make || vehicleData?.Make,
        model: vehicleData?.model || vehicleData?.Model,
        engine: vehicleData?.engine || vehicleData?.Engine,
        serviceItemId: cachedWO.serviceItemId,
      },
      
      job: {
        title,
        description,
        code: pkg.Code || pkg.code || pkg.ServicePackageHeader?.Code,
        chapter: pkg.Chapter || pkg.chapter,
        keywords: extractKeywords(title, description),
      },
      
      lines,
      
      totals: {
        laborHours,
        laborAmount,
        partsAmount,
        totalAmount,
      },
      
      metadata: {
        indexedAt: new Date(),
        sourceType: "protractor",
      },
    });
  }
  
  return entries;
}

export async function upsertJobIndexEntries(entries: JobIndexEntry[]): Promise<{ inserted: number; updated: number }> {
  if (entries.length === 0) {
    return { inserted: 0, updated: 0 };
  }
  
  const db = await getDb();
  const collection = db.collection("job_index");
  
  let inserted = 0;
  let updated = 0;
  
  // Track labor rates per shop to cache the most recent one
  const shopLaborRates = new Map<number, number>();
  
  for (const entry of entries) {
    const filter = {
      shopId: entry.shopId,
      workOrderId: entry.workOrderId,
      servicePackageId: entry.servicePackageId,
    };
    
    const result = await collection.updateOne(
      filter,
      { $set: entry },
      { upsert: true }
    );
    
    if (result.upsertedCount > 0) {
      inserted++;
    } else if (result.modifiedCount > 0) {
      updated++;
    }
    
    // Extract labor rate from entry lines
    for (const line of entry.lines) {
      if (line.lineType === "labor" && line.unitPrice > 0) {
        shopLaborRates.set(entry.shopId, line.unitPrice);
        break;
      }
    }
  }
  
  // Cache labor rates at shop level for fast lookups
  if (shopLaborRates.size > 0) {
    const shopsCollection = db.collection("shops");
    for (const [shopId, laborRate] of shopLaborRates) {
      await shopsCollection.updateOne(
        { shopId },
        { $set: { cachedLaborRate: laborRate, cachedLaborRateUpdatedAt: new Date() } }
      );
    }
  }
  
  return { inserted, updated };
}

export async function updatePartCrossReferences(entries: JobIndexEntry[]): Promise<number> {
  const db = await getDb();
  const collection = db.collection("part_cross_ref");
  
  let updatedCount = 0;
  
  const partsByShop = new Map<number, Map<string, { 
    entry: JobIndexEntry; 
    line: JobLineItem;
    workOrderId: string;
  }[]>>();
  
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.lineType !== "part" || !line.partNumber) continue;
      
      const normalized = normalizePartNumber(line.partNumber);
      if (!normalized) continue;
      
      if (!partsByShop.has(entry.shopId)) {
        partsByShop.set(entry.shopId, new Map());
      }
      
      const shopParts = partsByShop.get(entry.shopId)!;
      if (!shopParts.has(normalized)) {
        shopParts.set(normalized, []);
      }
      
      shopParts.get(normalized)!.push({ entry, line, workOrderId: entry.workOrderId });
    }
  }
  
  for (const [shopId, shopParts] of partsByShop) {
    for (const [normalizedPartNumber, usages] of shopParts) {
      const firstUsage = usages[0];
      
      const usedOn = usages
        .filter(u => u.entry.vehicle.year && u.entry.vehicle.make && u.entry.vehicle.model)
        .map(u => ({
          year: u.entry.vehicle.year!,
          make: u.entry.vehicle.make!,
          model: u.entry.vehicle.model!,
          engine: u.entry.vehicle.engine,
        }));
      
      const uniqueUsedOn = Array.from(
        new Map(usedOn.map(u => [`${u.year}-${u.make}-${u.model}`, u])).values()
      );
      
      const uniqueWorkOrderIds = [...new Set(usages.map(u => u.workOrderId))];
      
      const existing = await collection.findOne({ shopId, normalizedPartNumber });
      const existingWorkOrderIds = new Set(existing?.workOrderIds || []);
      const newWorkOrderIds = uniqueWorkOrderIds.filter(id => !existingWorkOrderIds.has(id));
      const newUsageCount = newWorkOrderIds.length;
      
      if (newUsageCount === 0 && existing) {
        await collection.updateOne(
          { shopId, normalizedPartNumber },
          {
            $set: { updatedAt: new Date() },
            $addToSet: { usedOn: { $each: uniqueUsedOn } },
          }
        );
      } else {
        await collection.updateOne(
          { shopId, normalizedPartNumber },
          {
            $set: {
              shopId,
              partNumber: firstUsage.line.partNumber,
              normalizedPartNumber,
              description: firstUsage.line.description,
              manufacturer: firstUsage.line.manufacturer,
              updatedAt: new Date(),
              lastUsedAt: new Date(),
            },
            $setOnInsert: {
              crossReferences: [],
              createdAt: new Date(),
            },
            $inc: { usageCount: newUsageCount || 1 },
            $addToSet: { 
              usedOn: { $each: uniqueUsedOn },
              workOrderIds: { $each: uniqueWorkOrderIds },
            },
          },
          { upsert: true }
        );
      }
      
      updatedCount++;
    }
  }
  
  return updatedCount;
}

export async function ensureJobIndexIndexes(): Promise<void> {
  const db = await getDb();
  
  const jobIndex = db.collection("job_index");
  await jobIndex.createIndex({ shopId: 1, "job.keywords": 1 });
  await jobIndex.createIndex({ shopId: 1, "vehicle.make": 1, "vehicle.model": 1 });
  await jobIndex.createIndex({ shopId: 1, "vehicle.year": 1, "vehicle.make": 1, "vehicle.model": 1 });
  await jobIndex.createIndex({ shopId: 1, performedAt: -1 });
  await jobIndex.createIndex({ shopId: 1, workOrderId: 1, servicePackageId: 1 }, { unique: true });
  await jobIndex.createIndex({ "job.title": "text", "job.description": "text", "lines.description": "text" });
  
  const partXref = db.collection("part_cross_ref");
  await partXref.createIndex({ shopId: 1, normalizedPartNumber: 1 }, { unique: true });
  await partXref.createIndex({ shopId: 1, partNumber: 1 });
  await partXref.createIndex({ shopId: 1, "usedOn.make": 1, "usedOn.model": 1 });
  await partXref.createIndex({ shopId: 1, workOrderIds: 1 });
  
  console.log("[JobIndex] Database indexes created");
}
