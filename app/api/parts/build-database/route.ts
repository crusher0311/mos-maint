import { NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
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

  const shopId = String(session.shopId);
  
  try {
    const partsMap = new Map<string, PartEntry>();
    
    let workOrdersScanned = 0;
    let invoicesScanned = 0;
    let linesProcessed = 0;
    
    const vehicles = await sql`SELECT * FROM protractor_vehicles WHERE shop_id = ${shopId}`;
    const vehicleByVin = new Map(vehicles.map((v: any) => [v.vin?.toUpperCase(), v]));
    
    console.log(`[Parts Build] Starting comprehensive parts extraction for shop ${shopId}`);
    console.log(`[Parts Build] Found ${vehicles.length} vehicles for reference`);
    
    const workOrders = await sql`SELECT * FROM protractor_work_orders WHERE shop_id = ${shopId}`;
    console.log(`[Parts Build] Processing ${workOrders.length} work orders...`);
    
    for (const wo of workOrders) {
      workOrdersScanned++;
      const vin = wo.vin?.toUpperCase();
      const vehicle = vin ? vehicleByVin.get(vin) : null;
      const vehicleKey = vehicle ? `${vehicle.year}-${vehicle.make}-${vehicle.model}` : null;
      
      const servicePackages = wo.service_packages || wo.data?.servicePackages;
      const packages = servicePackages?.ItemCollection || servicePackages || [];
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
          if (wo.work_order_id) entry.workOrderIds.add(wo.work_order_id);
          if (vehicleKey) entry.vehicles.add(vehicleKey);
        }
      }
    }
    
    const invoices = await sql`SELECT * FROM protractor_invoices WHERE shop_id = ${shopId}`;
    console.log(`[Parts Build] Processing ${invoices.length} invoices...`);
    
    for (const inv of invoices) {
      invoicesScanned++;
      const vin = inv.vin?.toUpperCase();
      const vehicle = vin ? vehicleByVin.get(vin) : null;
      const vehicleKey = vehicle ? `${vehicle.year}-${vehicle.make}-${vehicle.model}` : null;
      
      const servicePackages = inv.service_packages || inv.data?.servicePackages;
      const packages = servicePackages?.ItemCollection || servicePackages || [];
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
          if (inv.invoice_id) entry.workOrderIds.add(inv.invoice_id);
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
    
    let created = 0;
    let updated = 0;
    
    for (const [normalized, entry] of partsMap) {
      const usedOn = Array.from(entry.vehicles).map(v => {
        const [year, make, model] = v.split("-");
        return { year: parseInt(year) || 0, make, model };
      }).filter(v => v.year && v.make && v.model);
      
      const workOrderIds = Array.from(entry.workOrderIds);
      
      const existing = await sql`
        SELECT id, used_on, work_order_ids FROM part_cross_ref 
        WHERE shop_id = ${shopId} AND normalized_part_number = ${normalized}
      `;
      
      if (existing.length === 0) {
        await sql`
          INSERT INTO part_cross_ref (
            shop_id, part_number, normalized_part_number, description, manufacturer,
            usage_count, used_on, work_order_ids, cross_references, created_at, updated_at, last_used_at
          ) VALUES (
            ${shopId}, ${entry.partNumber}, ${normalized}, ${entry.description}, ${entry.manufacturer || null},
            ${entry.usageCount}, ${JSON.stringify(usedOn)}::jsonb, ${JSON.stringify(workOrderIds)}::jsonb, 
            '[]'::jsonb, NOW(), NOW(), NOW()
          )
        `;
        created++;
      } else {
        const existingUsedOn = existing[0].used_on || [];
        const existingWoIds = existing[0].work_order_ids || [];
        const mergedUsedOn = [...existingUsedOn, ...usedOn.filter((u: any) => 
          !existingUsedOn.some((e: any) => e.year === u.year && e.make === u.make && e.model === u.model)
        )];
        const mergedWoIds = [...new Set([...existingWoIds, ...workOrderIds])];
        
        await sql`
          UPDATE part_cross_ref SET
            part_number = ${entry.partNumber},
            description = ${entry.description},
            manufacturer = ${entry.manufacturer || null},
            usage_count = ${entry.usageCount},
            used_on = ${JSON.stringify(mergedUsedOn)}::jsonb,
            work_order_ids = ${JSON.stringify(mergedWoIds)}::jsonb,
            updated_at = NOW(),
            last_used_at = NOW()
          WHERE shop_id = ${shopId} AND normalized_part_number = ${normalized}
        `;
        updated++;
      }
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
