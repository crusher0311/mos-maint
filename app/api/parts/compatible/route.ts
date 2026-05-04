import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";
import { updatePartCrossReferences, JobIndexEntry } from "@/lib/job-index";
import {
  pgCountPartCrossRef,
  pgFindCompatibleParts,
  type PartCrossRefRow,
} from "@/lib/db/repositories/wave1";

export const dynamic = "force-dynamic";

async function ensurePartsIndexed(shopId: number): Promise<void> {
  // Wave 1 (task #342): part_cross_ref is canonical in Postgres.
  const partsCount = await pgCountPartCrossRef(shopId);
  if (partsCount > 0) return;

  const db = await getDb();
  let jobEntries: JobIndexEntry[] = await db
    .collection<JobIndexEntry>("job_index")
    .find({ shopId })
    .toArray();

  if (jobEntries.length === 0) {
    const { extractJobIndexFromCachedWorkOrder, upsertJobIndexEntries } = await import(
      "@/lib/job-index"
    );
    const cachedWOs = await db
      .collection("protractor_work_orders")
      .find({ shopId })
      .toArray();

    if (cachedWOs.length > 0) {
      console.log(`[Parts] Building job index from ${cachedWOs.length} cached work orders`);
      const vehicles = await db.collection("protractor_vehicles").find({ shopId }).toArray();
      const vehicleByVin = new Map(vehicles.map((v) => [v.vin?.toUpperCase(), v]));

      const allEntries: JobIndexEntry[] = [];
      for (const wo of cachedWOs) {
        const vehicle = wo.vin ? vehicleByVin.get(wo.vin.toUpperCase()) : null;
        const entries = extractJobIndexFromCachedWorkOrder(shopId, wo, vehicle);
        allEntries.push(...entries);
      }
      if (allEntries.length > 0) {
        await upsertJobIndexEntries(allEntries);
        jobEntries = allEntries;
      }
    }
  }

  if (jobEntries.length > 0) {
    console.log(`[Parts] Auto-indexing ${jobEntries.length} jobs for shop ${shopId}`);
    await updatePartCrossReferences(jobEntries);
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = session.shopId;

  const enabled = await isFeatureEnabled(shopId, "part_xref");
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

  const results = await pgFindCompatibleParts({ shopId, year, make, model, limit: 100 });

  const grouped: Record<string, PartCrossRefRow[]> = {};
  for (const part of results) {
    const category = categorizePartByDescription(part.description || "");
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(part);
  }

  return NextResponse.json({
    ok: true,
    vehicle: { year, make, model },
    categories: Object.entries(grouped).map(([category, parts]) => ({
      category,
      parts: parts.map((p) => ({
        partNumber: p.partNumber,
        description: p.description,
        manufacturer: p.manufacturer,
        usageCount: p.usageCount,
        lastUsedAt: p.lastUsedAt,
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
