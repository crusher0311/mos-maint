import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
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

async function ensurePartsIndexed(shopId: number): Promise<void> {
  const db = await getDb();
  const partsCount = await db.collection("part_cross_ref").countDocuments({ shopId });
  
  if (partsCount === 0) {
    const jobEntries = await db.collection<JobIndexEntry>("job_index")
      .find({ shopId })
      .toArray();
    
    if (jobEntries.length > 0) {
      console.log(`[Parts] Auto-indexing ${jobEntries.length} jobs for shop ${shopId}`);
      await updatePartCrossReferences(jobEntries);
    }
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

  const db = await getDb();
  
  await ensurePartsIndexed(shopId);
  const collection = db.collection<PartCrossRef>("part_cross_ref");

  const results = await collection
    .find({
      shopId,
      "usedOn.year": year,
      "usedOn.make": { $regex: `^${make}$`, $options: "i" },
      "usedOn.model": { $regex: `^${model}$`, $options: "i" },
    })
    .sort({ usageCount: -1 })
    .limit(100)
    .toArray();

  const grouped: Record<string, typeof results> = {};
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
      parts: parts.map(p => ({
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
