import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { getSession } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";
import { updatePartCrossReferences, JobIndexEntry } from "@/lib/job-index";

export const dynamic = "force-dynamic";

type PartCrossRef = {
  shopId: number;
  partNumber: string;
  normalizedPartNumber: string;
  description?: string;
  manufacturer?: string;
  usedOn: { year: number; make: string; model: string; engine?: string }[];
  crossReferences: string[];
  usageCount: number;
  workOrderIds: string[];
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

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
  const query = searchParams.get("q")?.trim() || "";
  const make = searchParams.get("make")?.trim() || "";
  const model = searchParams.get("model")?.trim() || "";
  const year = searchParams.get("year")?.trim() || "";

  if (!query && !make && !model && !year) {
    return NextResponse.json({ error: "Please provide a search query or vehicle filter" }, { status: 400 });
  }

  await ensurePartsIndexed(shopId);

  let results: any[];
  
  if (query) {
    const normalizedQuery = query.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    const searchPattern = `%${query}%`;
    const normalizedPattern = `%${normalizedQuery}%`;
    
    results = await sql`
      SELECT * FROM part_cross_ref
      WHERE shop_id = ${shopId}
        AND (
          normalized_part_number ILIKE ${normalizedPattern}
          OR part_number ILIKE ${searchPattern}
          OR description ILIKE ${searchPattern}
        )
        ${make ? sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements(used_on) u WHERE u->>'make' ILIKE ${`%${make}%`})` : sql``}
        ${model ? sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements(used_on) u WHERE u->>'model' ILIKE ${`%${model}%`})` : sql``}
        ${year ? sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements(used_on) u WHERE (u->>'year')::int = ${parseInt(year, 10)})` : sql``}
      ORDER BY usage_count DESC, last_used_at DESC NULLS LAST
      LIMIT 50
    `;
  } else {
    results = await sql`
      SELECT * FROM part_cross_ref
      WHERE shop_id = ${shopId}
        ${make ? sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements(used_on) u WHERE u->>'make' ILIKE ${`%${make}%`})` : sql``}
        ${model ? sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements(used_on) u WHERE u->>'model' ILIKE ${`%${model}%`})` : sql``}
        ${year ? sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements(used_on) u WHERE (u->>'year')::int = ${parseInt(year, 10)})` : sql``}
      ORDER BY usage_count DESC, last_used_at DESC NULLS LAST
      LIMIT 50
    `;
  }

  return NextResponse.json({
    ok: true,
    results: results.map((r: any) => ({
      partNumber: r.part_number,
      normalizedPartNumber: r.normalized_part_number,
      description: r.description,
      manufacturer: r.manufacturer,
      usedOn: r.used_on,
      crossReferences: r.cross_references,
      usageCount: r.usage_count,
      lastUsedAt: r.last_used_at,
    })),
    count: results.length,
  });
}
