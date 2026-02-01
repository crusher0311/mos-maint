// lib/job-index.ts
// Job Lookup / Parts Intelligence - Data Indexing Layer

import sql from "@/lib/db/postgres";
import crypto from "crypto";

export function computeJobHash(entry: JobIndexEntry): string {
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
  isDeferred?: boolean;
  
  vehicle: {
    vin?: string;
    year?: number;
    make?: string;
    model?: string;
    engine?: string;
    serviceItemId?: string;
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
  
  const deferredPackages = workOrder.DeferredServicePackages?.ItemCollection || 
                           workOrder.DeferredServicePackages || 
                           [];
  
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
      workOrderId: workOrder.ID || workOrder.id,
      workOrderNumber: workOrder.WorkOrderNumber || workOrder.workOrderNumber,
      servicePackageId: pkg.ID || pkg.id,
      performedAt: new Date(performedAt),
      isDeferred,
      
      vehicle: {
        vin: vehicle.VIN || vehicle.vin,
        year: vehicle.Year || vehicle.year,
        make: vehicle.Make || vehicle.make,
        model: vehicle.Model || vehicle.model,
        engine: vehicle.Engine || vehicle.engine,
        serviceItemId: vehicle.ID || vehicle.id,
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
  
  let inserted = 0;
  let updated = 0;
  
  const shopLaborRates = new Map<number, number>();
  
  for (const entry of entries) {
    const shopIdStr = String(entry.shopId);
    const contentHash = computeJobHash(entry);
    
    const existingRows = await sql`
      SELECT id, content_hash
      FROM job_index ji
      JOIN shops s ON ji.shop_id = s.id
      WHERE s.shop_id = ${shopIdStr}
        AND ji.work_order_id = ${entry.workOrderId}
        AND ji.job_label = ${entry.servicePackageId}
      LIMIT 1
    `;
    
    const existing = existingRows[0];
    
    if (existing) {
      if (existing.content_hash !== contentHash) {
        await sql`
          UPDATE job_index
          SET 
            job_title = ${entry.job.title},
            keywords = ${entry.job.keywords},
            vehicle_make = ${entry.vehicle.make || null},
            vehicle_model = ${entry.vehicle.model || null},
            vehicle_year = ${entry.vehicle.year || null},
            labor_amount = ${entry.totals.laborAmount},
            parts_amount = ${entry.totals.partsAmount},
            total_amount = ${entry.totals.totalAmount},
            labor_hours = ${entry.totals.laborHours},
            performed_at = ${entry.performedAt},
            job = ${JSON.stringify(entry.job)}::jsonb,
            lines = ${JSON.stringify(entry.lines)}::jsonb,
            totals = ${JSON.stringify(entry.totals)}::jsonb,
            content_hash = ${contentHash}
          WHERE id = ${existing.id}
        `;
        updated++;
      }
    } else {
      await sql`
        INSERT INTO job_index (
          shop_id, vin, work_order_id, job_title, job_label, keywords,
          vehicle_make, vehicle_model, vehicle_year,
          labor_amount, parts_amount, total_amount, labor_hours,
          performed_at, job, lines, totals, content_hash, created_at
        )
        SELECT 
          s.id,
          ${entry.vehicle.vin?.toUpperCase() || null},
          ${entry.workOrderId},
          ${entry.job.title},
          ${entry.servicePackageId},
          ${entry.job.keywords},
          ${entry.vehicle.make || null},
          ${entry.vehicle.model || null},
          ${entry.vehicle.year || null},
          ${entry.totals.laborAmount},
          ${entry.totals.partsAmount},
          ${entry.totals.totalAmount},
          ${entry.totals.laborHours},
          ${entry.performedAt},
          ${JSON.stringify(entry.job)}::jsonb,
          ${JSON.stringify(entry.lines)}::jsonb,
          ${JSON.stringify(entry.totals)}::jsonb,
          ${contentHash},
          NOW()
        FROM shops s
        WHERE s.shop_id = ${shopIdStr}
      `;
      inserted++;
    }
    
    for (const line of entry.lines) {
      if (line.lineType === "labor" && line.unitPrice > 0) {
        shopLaborRates.set(entry.shopId, line.unitPrice);
        break;
      }
    }
  }
  
  if (shopLaborRates.size > 0) {
    for (const [shopId, laborRate] of shopLaborRates) {
      const shopIdStr = String(shopId);
      await sql`
        UPDATE shops
        SET 
          settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
            'cachedLaborRate', ${laborRate},
            'cachedLaborRateUpdatedAt', ${new Date().toISOString()}
          )
        WHERE shop_id = ${shopIdStr}
      `;
    }
  }
  
  return { inserted, updated };
}

export async function updatePartCrossReferences(entries: JobIndexEntry[]): Promise<number> {
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
    const shopIdStr = String(shopId);
    
    for (const [normalizedPartNumber, usages] of shopParts) {
      const firstUsage = usages[0];
      
      const existingRows = await sql`
        SELECT original_part_number
        FROM part_cross_ref
        WHERE original_part_number = ${normalizedPartNumber}
        LIMIT 1
      `;
      
      if (existingRows.length === 0) {
        await sql`
          INSERT INTO part_cross_ref (original_part_number, manufacturer, notes, verified, created_at)
          VALUES (
            ${normalizedPartNumber},
            ${firstUsage.line.manufacturer || null},
            ${firstUsage.line.description || null},
            false,
            NOW()
          )
          ON CONFLICT DO NOTHING
        `;
      }
      
      updatedCount++;
    }
  }
  
  return updatedCount;
}

export async function ensureJobIndexIndexes(): Promise<void> {
  console.log("[JobIndex] PostgreSQL indexes managed by schema");
}
