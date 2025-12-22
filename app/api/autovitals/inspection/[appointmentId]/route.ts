import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getShopAutoVitalsConfig,
  getInspectionResults,
  cacheAutoVitalsInspection,
  getCachedAutoVitalsInspection,
} from "@/lib/integrations/autovitals";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> }
) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = { shopId: String(session.shopId) };
    const { appointmentId: appointmentIdStr } = await params;

    const appointmentId = parseInt(appointmentIdStr);
    if (isNaN(appointmentId)) {
      return NextResponse.json({ error: "Invalid appointment ID" }, { status: 400 });
    }

    const cached = await getCachedAutoVitalsInspection(appointmentId, user.shopId);
    
    const cacheMaxAge = 6 * 60 * 60 * 1000;
    if (cached && cached.updatedAt && Date.now() - new Date(cached.updatedAt).getTime() < cacheMaxAge) {
      return NextResponse.json({ 
        inspection: cached, 
        source: "cache" 
      });
    }

    const config = await getShopAutoVitalsConfig(user.shopId);
    if (!config) {
      if (cached) {
        return NextResponse.json({ 
          inspection: cached, 
          source: "cache_fallback" 
        });
      }
      return NextResponse.json({ 
        error: "AutoVitals is not configured" 
      }, { status: 400 });
    }

    const result = await getInspectionResults(appointmentId, config);
    if (!result.ok) {
      if (cached) {
        return NextResponse.json({ 
          inspection: cached, 
          source: "cache_fallback" 
        });
      }
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    await cacheAutoVitalsInspection(result.data, user.shopId);

    return NextResponse.json({ 
      inspection: result.data, 
      source: "api" 
    });
  } catch (error) {
    console.error("[AutoVitals Inspection] Error:", error);
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : "Failed to fetch inspection" 
    }, { status: 500 });
  }
}
