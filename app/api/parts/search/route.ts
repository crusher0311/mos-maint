import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";
import { updatePartCrossReferences, JobIndexEntry } from "@/lib/job-index";
import { pgCountPartCrossRef, pgSearchPartCrossRef } from "@/lib/db/repositories/wave1";

export const dynamic = "force-dynamic";

async function ensurePartsIndexed(shopId: number): Promise<void> {
  // Wave 1 (task #342): part_cross_ref is canonical in Postgres.
  const partsCount = await pgCountPartCrossRef(shopId);
  if (partsCount > 0) return;

  // Bootstrap from job_index (or cached protractor work orders) the
  // first time we see a shop. The bootstrap data still lives in Mongo
  // because protractor_work_orders / job_index are NOT in Wave 1 scope.
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
  const query = searchParams.get("q")?.trim() || "";
  const make = searchParams.get("make")?.trim() || "";
  const model = searchParams.get("model")?.trim() || "";
  const yearStr = searchParams.get("year")?.trim() || "";

  if (!query && !make && !model && !yearStr) {
    return NextResponse.json(
      { error: "Please provide a search query or vehicle filter" },
      { status: 400 },
    );
  }

  await ensurePartsIndexed(shopId);

  const yearNum = yearStr ? parseInt(yearStr, 10) : NaN;
  const results = await pgSearchPartCrossRef({
    shopId,
    query: query || undefined,
    make: make || undefined,
    model: model || undefined,
    year: Number.isFinite(yearNum) ? yearNum : undefined,
    limit: 50,
  });

  return NextResponse.json({
    ok: true,
    results: results.map((r) => ({
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
