// app/api/recommended/cache/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  getAiAnalysisDoc,
  upsertAiAnalysisDoc,
} from "@/lib/data/repositories/plan-cache-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Get cached analysis
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const vin = searchParams.get('vin');
    
    if (!vin) {
      return NextResponse.json({ error: "VIN required" }, { status: 400 });
    }

    // Task #998: dispatches through the plan-cache store facade
    // (PG-canonical behind PLAN_CACHE_PG_CANONICAL, Mongo otherwise).
    // 24h TTL is applied here (was the Mongo createdAt filter).
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    let cached = await getAiAnalysisDoc(Number(session.shopId), vin);
    if (cached) {
      const createdAt = cached.createdAt ? new Date(cached.createdAt as string | Date) : null;
      if (!createdAt || createdAt < oneDayAgo) cached = null;
    }

    if (cached) {
      return NextResponse.json({
        ok: true,
        cached: true,
        ...cached.result
      });
    }

    return NextResponse.json({
      ok: false,
      cached: false,
      message: "No cached analysis found"
    });

  } catch (error: any) {
    console.error("Cache lookup error:", error);
    return NextResponse.json({ error: "Cache lookup failed" }, { status: 500 });
  }
}

// Save analysis to cache
export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { vin, result } = await request.json();
    
    if (!vin || !result) {
      return NextResponse.json({ error: "VIN and result required" }, { status: 400 });
    }

    // Save to cache (task #998: flag-dispatched PG/Mongo facade write).
    await upsertAiAnalysisDoc(Number(session.shopId), vin, result);

    return NextResponse.json({ ok: true, cached: true });

  } catch (error: any) {
    console.error("Cache save error:", error);
    return NextResponse.json({ error: "Cache save failed" }, { status: 500 });
  }
}