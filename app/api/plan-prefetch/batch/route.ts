import { NextResponse, NextRequest } from "next/server";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSquish(vin: string) {
  const v = String(vin).toUpperCase().trim();
  return v.slice(0, 8) + v.slice(9, 11);
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const body = await req.json();
    const vins: string[] = body.vins || [];
    
    if (!Array.isArray(vins) || vins.length === 0) {
      return NextResponse.json({ error: "vins array required" }, { status: 400 });
    }

    const validVins = vins
      .map((v: string) => String(v).toUpperCase().trim())
      .filter((v: string) => v.length === 17)
      .slice(0, 10);

    if (validVins.length === 0) {
      return NextResponse.json({ error: "No valid VINs provided" }, { status: 400 });
    }

    const results: Record<string, { status: string; duration?: number }> = {};

    const carfaxCfg = await resolveCarfaxConfig(shopId);

    const prefetchPromises = validVins.map(async (vin: string) => {
      const vinStart = Date.now();
      try {
        const squish = toSquish(vin);
        
        await Promise.allSettled([
          getMaintenanceScheduleCached(squish).catch(() => null),
          carfaxCfg.configured 
            ? fetchCarfaxWithCache(shopId, vin, 7 * 24 * 60 * 60 * 1000).catch(() => null)
            : Promise.resolve(null),
        ]);
        
        results[vin] = { 
          status: "prefetched", 
          duration: Date.now() - vinStart 
        };
      } catch (err) {
        console.error(`Batch prefetch error for ${vin}:`, err);
        results[vin] = { 
          status: "error", 
          duration: Date.now() - vinStart 
        };
      }
    });

    await Promise.allSettled(prefetchPromises);

    const duration = Date.now() - startTime;
    console.log(`[BatchPrefetch] ${validVins.length} VINs completed in ${duration}ms`);

    return NextResponse.json({
      ok: true,
      count: validVins.length,
      duration,
      results,
    }, { status: 202 });

  } catch (err: any) {
    console.error("[BatchPrefetch] Error:", err);
    return NextResponse.json(
      { error: "Batch prefetch failed", details: err.message },
      { status: 500 }
    );
  }
}
