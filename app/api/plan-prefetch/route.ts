import { NextResponse, NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prefetchPlanData, isPlanPrefetched } from "@/lib/plan-builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const vin = req.nextUrl.searchParams.get("vin")?.toUpperCase();
    const mileageParam = req.nextUrl.searchParams.get("mileage");
    const mileage = mileageParam ? parseInt(mileageParam, 10) : null;
    
    if (!vin || vin.length !== 17) {
      return NextResponse.json(
        { error: "Valid 17-character VIN required" },
        { status: 400 }
      );
    }
    
    if (!mileage || mileage <= 0) {
      console.log(`[Prefetch] Skipping ${vin} - no valid mileage provided`);
      return NextResponse.json(
        { ok: true, vin, skipped: true, reason: "No mileage provided" },
        { status: 200 }
      );
    }

    const alreadyPrefetched = await isPlanPrefetched(vin, shopId);
    if (alreadyPrefetched) {
      console.log(`[Prefetch] ${vin} already cached, skipping`);
      return NextResponse.json({
        ok: true,
        vin,
        cached: true,
        message: "Plan data already cached",
        timestamp: new Date().toISOString()
      }, { status: 200 });
    }
    
    console.log(`[Prefetch] Starting prefetch for ${vin} at ${mileage} miles`);

    const result = await prefetchPlanData(shopId, vin, mileage);

    console.log(`[Prefetch] VIN ${vin} at ${mileage} miles completed in ${result.duration}ms:`, result.results);

    return NextResponse.json({
      ok: true,
      vin,
      message: "Plan data prefetched",
      duration: result.duration,
      results: result.results,
      timestamp: new Date().toISOString()
    }, { status: 202 });

  } catch (err: any) {
    console.error("[Prefetch] Error:", err);
    return NextResponse.json(
      { error: "Prefetch failed", details: err.message },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json(
    { error: "Use POST method to prefetch plan data" },
    { status: 405 }
  );
}
