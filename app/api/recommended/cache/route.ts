// app/api/recommended/cache/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

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

    const db = await getDb();
    
    // Look for cached analysis (valid for 24 hours)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const cached = await db.collection("ai_analysis_cache").findOne({
      shopId: Number(session.shopId),
      vin: vin.toUpperCase(),
      createdAt: { $gte: oneDayAgo }
    });

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

    const db = await getDb();
    
    // Save to cache
    await db.collection("ai_analysis_cache").updateOne(
      {
        shopId: Number(session.shopId),
        vin: vin.toUpperCase()
      },
      {
        $set: {
          shopId: Number(session.shopId),
          vin: vin.toUpperCase(),
          result,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    return NextResponse.json({ ok: true, cached: true });

  } catch (error: any) {
    console.error("Cache save error:", error);
    return NextResponse.json({ error: "Cache save failed" }, { status: 500 });
  }
}