import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { getSession } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";
import { updatePartCrossReferences, JobIndexEntry } from "@/lib/job-index";

export const dynamic = "force-dynamic";

async function ensurePartsIndexed(shopId: string): Promise<void> {
  const partsCountRows = await sql`SELECT COUNT(*)::int as count FROM part_cross_ref WHERE shop_id = ${shopId}`;
  const partsCount = partsCountRows[0]?.count || 0;
  
  if (partsCount === 0) {
    const jobEntries = await sql`SELECT * FROM job_index WHERE shop_id = ${shopId}`;
    
    if (jobEntries.length === 0) {
      const cachedWOs = await sql`SELECT * FROM protractor_work_orders WHERE shop_id = ${shopId}`;
      
      if (cachedWOs.length > 0) {
        console.log(`[Parts] Building job index from ${cachedWOs.length} cached work orders`);
        
        const vehicles = await sql`SELECT * FROM protractor_vehicles WHERE shop_id = ${shopId}`;
        const vehicleByVin = new Map(vehicles.map((v: any) => [v.vin?.toUpperCase(), v]));
        
        const { extractJobIndexFromCachedWorkOrder, upsertJobIndexEntries } = await import("@/lib/job-index");
        const allEntries: JobIndexEntry[] = [];
        for (const wo of cachedWOs) {
          const vehicle = wo.vin ? vehicleByVin.get(wo.vin.toUpperCase()) : null;
          const entries = extractJobIndexFromCachedWorkOrder(Number(shopId), wo, vehicle);
          allEntries.push(...entries);
        }
        if (allEntries.length > 0) {
          await upsertJobIndexEntries(allEntries);
          await updatePartCrossReferences(allEntries);
        }
      }
    } else {
      console.log(`[Parts] Auto-indexing ${jobEntries.length} jobs for shop ${shopId}`);
      await updatePartCrossReferences(jobEntries as unknown as JobIndexEntry[]);
    }
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = String(session.shopId);
  
  const enabled = await isFeatureEnabled(session.shopId, "part_xref");
  if (!enabled) {
    return NextResponse.json({ error: "Feature not enabled for this shop" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const year = parseInt(searchParams.get("year") || "", 10);
  const make = searchParams.get("make")?.trim() || "";
  const model = searchParams.get("model")?.trim() || "";

  if (!year || !make || !model) {
    return NextResponse.json({ error: "year, make, and model are required" }, { status: 400 });
  }

  await ensurePartsIndexed(shopId);

  const results = await sql`
    SELECT * FROM part_cross_ref
    WHERE shop_id = ${shopId}
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(used_on) u 
        WHERE (u->>'year')::int = ${year}
          AND u->>'make' ILIKE ${make}
          AND u->>'model' ILIKE ${model}
      )
    ORDER BY usage_count DESC
    LIMIT 100
  `;

  const grouped: Record<string, any[]> = {};
  for (const part of results) {
    const category = categorizePartByDescription(part.description || "");
    if (!grouped[category]) {
      grouped[category] = [];
    }
    grouped[category].push(part);
  }

  return NextResponse.json({
    ok: true,
    vehicle: { year, make, model },
    categories: Object.entries(grouped).map(([category, parts]) => ({
      category,
      parts: parts.map((p: any) => ({
        partNumber: p.part_number,
        description: p.description,
        manufacturer: p.manufacturer,
        usageCount: p.usage_count,
        lastUsedAt: p.last_used_at,
      })),
    })),
    totalParts: results.length,
  });
}

function categorizePartByDescription(description: string): string {
  const desc = description.toLowerCase();
  
  if (desc.includes("oil") && desc.includes("filter")) return "Oil Filters";
  if (desc.includes("air") && desc.includes("filter")) return "Air Filters";
  if (desc.includes("cabin") && desc.includes("filter")) return "Cabin Filters";
  if (desc.includes("fuel") && desc.includes("filter")) return "Fuel Filters";
  if (desc.includes("brake") && desc.includes("pad")) return "Brake Pads";
  if (desc.includes("brake") && desc.includes("rotor")) return "Brake Rotors";
  if (desc.includes("spark") && desc.includes("plug")) return "Spark Plugs";
  if (desc.includes("battery")) return "Batteries";
  if (desc.includes("wiper")) return "Wiper Blades";
  if (desc.includes("belt")) return "Belts";
  if (desc.includes("coolant") || desc.includes("antifreeze")) return "Coolant";
  if (desc.includes("oil") || desc.includes("motor oil")) return "Motor Oil";
  if (desc.includes("transmission")) return "Transmission";
  if (desc.includes("alternator")) return "Alternators";
  if (desc.includes("starter")) return "Starters";
  
  return "Other Parts";
}
