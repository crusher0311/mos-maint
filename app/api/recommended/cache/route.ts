// app/api/recommended/cache/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const cachedRows = await sql`
      SELECT * FROM ai_analysis_cache
      WHERE shop_id = ${String(session.shopId)}
        AND vin = ${vin.toUpperCase()}
        AND created_at >= ${oneDayAgo}
    `;
    const cached = cachedRows[0] as any;

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

    await sql`
      INSERT INTO ai_analysis_cache (shop_id, vin, result, created_at, updated_at)
      VALUES (${String(session.shopId)}, ${vin.toUpperCase()}, ${JSON.stringify(result)}::jsonb, NOW(), NOW())
      ON CONFLICT (shop_id, vin) DO UPDATE SET result = ${JSON.stringify(result)}::jsonb, updated_at = NOW()
    `;

    return NextResponse.json({ ok: true, cached: true });

  } catch (error: any) {
    console.error("Cache save error:", error);
    return NextResponse.json({ error: "Cache save failed" }, { status: 500 });
  }
}
