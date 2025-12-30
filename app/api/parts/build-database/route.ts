import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

type PartEntry = {
  partNumber: string;
  normalizedPartNumber: string;
  description: string;
  manufacturer?: string;
  vehicles: Set<string>;
  workOrderIds: Set<string>;
  usageCount: number;
};

function normalizePartNumber(partNumber: string): string {
  return partNumber.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  
  try {
    const db = await getDb();
    const partsMap = new Map<string, PartEntry>();
    
    let workOrdersScanned = 0;
    let invoicesScanned = 0;
    let linesProcessed = 0;
    
    const vehicles = await db.collection("protractor_vehicles").find({ shopId }).toArray();
    const vehicleByVin = new Map(vehicles.map(v => [v.vin?.toUpperCase(), v]));
    
    console.log(`[Parts Build] Starting comprehensive parts extraction for shop ${shopId}`);
    console.log(`[Parts Build] Found ${vehicles.length} vehicles for reference`);
    
    const workOrders = await db.collection("protractor_work_orders").find({ shopId }).toArray();
    console.log(`[Parts Build] Processing ${workOrders.length} work orders...`);
    
    for (const wo of workOrders) {
      workOrdersScanned++;
      const vin = wo.vin?.toUpperCase();
      const vehicle = vin ? vehicleByVin.get(vin) : null;
      const vehicleKey = vehicle ? `${vehicle.year}-${vehicle.make}-${vehicle.model}` : null;
      
      const packages = wo.servicePackages?.ItemCollection || wo.servicePackages || [];
      if (!Array.isArray(packages)) continue;
      
      for (const pkg of packages) {
        const lines = pkg.ServicePackageLines?.ItemCollection || pkg.ServicePackageLines || [];
        if (!Array.isArray(lines)) continue;
        
        for (const line of lines) {
          const lineType = (line.Type || line.LineType || "").toLowerCase();
          if (!lineType.includes("part") && !lineType.includes("material")) continue;
          
          const partNumber = line.PartNumber || line.partNumber;
          if (!partNumber) continue;
          
          linesProcessed++;
          const normalized = normalizePartNumber(partNumber);
          if (!normalized) continue;
          
          if (!partsMap.has(normalized)) {
            partsMap.set(normalized, {
              partNumber,
              normalizedPartNumber: normalized,
              description: line.Description || line.description || "",
              manufacturer: line.Manufacturer || line.manufacturer,
              vehicles: new Set(),
              workOrderIds: new Set(),
              usageCount: 0,
            });
          }
          
          const entry = partsMap.get(normalized)!;
          entry.usageCount++;
          if (wo.workOrderId) entry.workOrderIds.add(wo.workOrderId);
          if (vehicleKey) entry.vehicles.add(vehicleKey);
        }
      }
    }
    
    const invoices = await db.collection("protractor_invoices").find({ shopId }).toArray();
    console.log(`[Parts Build] Processing ${invoices.length} invoices...`);
    
    for (const inv of invoices) {
      invoicesScanned++;
      const vin = inv.vin?.toUpperCase();
      const vehicle = vin ? vehicleByVin.get(vin) : null;
      const vehicleKey = vehicle ? `${vehicle.year}-${vehicle.make}-${vehicle.model}` : null;
      
      const packages = inv.servicePackages?.ItemCollection || inv.servicePackages || [];
      if (!Array.isArray(packages)) continue;
      
      for (const pkg of packages) {
        const lines = pkg.ServicePackageLines?.ItemCollection || pkg.ServicePackageLines || [];
        if (!Array.isArray(lines)) continue;
        
        for (const line of lines) {
          const lineType = (line.Type || line.LineType || "").toLowerCase();
          if (!lineType.includes("part") && !lineType.includes("material")) continue;
          
          const partNumber = line.PartNumber || line.partNumber;
          if (!partNumber) continue;
          
          linesProcessed++;
          const normalized = normalizePartNumber(partNumber);
          if (!normalized) continue;
          
          if (!partsMap.has(normalized)) {
            partsMap.set(normalized, {
              partNumber,
              normalizedPartNumber: normalized,
              description: line.Description || line.description || "",
              manufacturer: line.Manufacturer || line.manufacturer,
              vehicles: new Set(),
              workOrderIds: new Set(),
              usageCount: 0,
            });
          }
          
          const entry = partsMap.get(normalized)!;
          entry.usageCount++;
          if (inv.invoiceId) entry.workOrderIds.add(inv.invoiceId);
          if (vehicleKey) entry.vehicles.add(vehicleKey);
        }
      }
    }
    
    console.log(`[Parts Build] Found ${partsMap.size} unique parts from ${linesProcessed} line items`);
    
    if (partsMap.size === 0) {
      return NextResponse.json({
        ok: true,
        message: "No parts found in work order history. The cached work orders may not include line item details.",
        partsCreated: 0,
        workOrdersScanned,
        invoicesScanned,
        linesProcessed,
      });
    }
    
    const collection = db.collection("part_cross_ref");
    let created = 0;
    let updated = 0;
    
    for (const [normalized, entry] of partsMap) {
      const usedOn = Array.from(entry.vehicles).map(v => {
        const [year, make, model] = v.split("-");
        return { year: parseInt(year) || 0, make, model };
      }).filter(v => v.year && v.make && v.model);
      
      const workOrderIds = Array.from(entry.workOrderIds);
      
      const result = await collection.updateOne(
        { shopId, normalizedPartNumber: normalized },
        {
          $set: {
            shopId,
            partNumber: entry.partNumber,
            normalizedPartNumber: normalized,
            description: entry.description,
            manufacturer: entry.manufacturer,
            usageCount: entry.usageCount,
            updatedAt: new Date(),
            lastUsedAt: new Date(),
          },
          $setOnInsert: {
            crossReferences: [],
            createdAt: new Date(),
          },
          $addToSet: {
            usedOn: { $each: usedOn },
            workOrderIds: { $each: workOrderIds },
          },
        },
        { upsert: true }
      );
      
      if (result.upsertedCount > 0) created++;
      else if (result.modifiedCount > 0) updated++;
    }
    
    console.log(`[Parts Build] Complete: ${created} created, ${updated} updated`);
    
    return NextResponse.json({
      ok: true,
      message: `Built parts database from ${workOrdersScanned} work orders and ${invoicesScanned} invoices`,
      partsCreated: created,
      partsUpdated: updated,
      totalParts: partsMap.size,
      workOrdersScanned,
      invoicesScanned,
      linesProcessed,
    });
  } catch (error) {
    console.error("[Parts Build] Error:", error);
    return NextResponse.json({ 
      error: "Failed to build parts database",
      details: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }
}
