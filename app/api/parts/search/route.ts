import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/mongo";
import { getSession } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";

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
  const query = searchParams.get("q")?.trim() || "";
  const make = searchParams.get("make")?.trim() || "";
  const model = searchParams.get("model")?.trim() || "";
  const year = searchParams.get("year")?.trim() || "";

  if (!query && !make && !model && !year) {
    return NextResponse.json({ error: "Please provide a search query or vehicle filter" }, { status: 400 });
  }

  const db = await getDb();
  const collection = db.collection<PartCrossRef>("part_cross_ref");

  const filter: Record<string, any> = { shopId };

  if (query) {
    const normalizedQuery = query.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    filter.$or = [
      { normalizedPartNumber: { $regex: normalizedQuery, $options: "i" } },
      { partNumber: { $regex: query, $options: "i" } },
      { description: { $regex: query, $options: "i" } },
    ];
  }

  if (make) {
    filter["usedOn.make"] = { $regex: make, $options: "i" };
  }
  if (model) {
    filter["usedOn.model"] = { $regex: model, $options: "i" };
  }
  if (year) {
    const yearNum = parseInt(year, 10);
    if (!isNaN(yearNum)) {
      filter["usedOn.year"] = yearNum;
    }
  }

  const results = await collection
    .find(filter)
    .sort({ usageCount: -1, lastUsedAt: -1 })
    .limit(50)
    .toArray();

  return NextResponse.json({
    ok: true,
    results: results.map(r => ({
      partNumber: r.partNumber,
      normalizedPartNumber: r.normalizedPartNumber,
      description: r.description,
      manufacturer: r.manufacturer,
      usedOn: r.usedOn,
      crossReferences: r.crossReferences,
      usageCount: r.usageCount,
      lastUsedAt: r.lastUsedAt,
    })),
    count: results.length,
  });
}
