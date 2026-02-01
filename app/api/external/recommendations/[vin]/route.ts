import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createExternalEndpoint(
  "recommendations:read",
  async (req: NextRequest, { shopId }) => {
    const vin = req.nextUrl.pathname.split("/").pop();
    
    if (!vin || vin.length < 11) {
      return NextResponse.json(
        { error: "Valid VIN is required" },
        { status: 400 }
      );
    }
    
    const mileage = Number(req.nextUrl.searchParams.get("mileage")) || undefined;
    const includeAI = req.nextUrl.searchParams.get("includeAI") === "true";
    
    try {
      const cachedRows = await sql`
        SELECT * FROM recommendations_cache 
        WHERE vin = ${vin.toUpperCase()} AND shop_id = ${String(shopId)}
        LIMIT 1
      `;
      const cachedRecs = cachedRows[0];
      
      if (cachedRecs && !includeAI) {
        const cacheAge = Date.now() - new Date(cachedRecs.updated_at).getTime();
        const maxAge = 24 * 60 * 60 * 1000;
        
        if (cacheAge < maxAge) {
          return NextResponse.json({
            success: true,
            vin,
            source: "cache",
            recommendations: cachedRecs.recommendations,
            cachedAt: cachedRecs.updated_at,
          });
        }
      }
      
      const { getMaintenanceRecommendations } = await import("@/lib/recommendations");
      
      const recommendations = await getMaintenanceRecommendations(vin, {
        shopId,
        mileage,
        includeAI,
      });
      
      await sql`
        INSERT INTO recommendations_cache (vin, shop_id, recommendations, updated_at)
        VALUES (${vin.toUpperCase()}, ${String(shopId)}, ${JSON.stringify(recommendations)}::jsonb, NOW())
        ON CONFLICT (vin, shop_id) DO UPDATE SET
          recommendations = ${JSON.stringify(recommendations)}::jsonb,
          updated_at = NOW()
      `;
      
      return NextResponse.json({
        success: true,
        vin,
        mileage,
        source: includeAI ? "ai_enhanced" : "oem",
        recommendations,
      });
      
    } catch (err: any) {
      console.error("[External API] Recommendations error:", err);
      return NextResponse.json(
        { error: "Failed to fetch recommendations", message: err.message },
        { status: 500 }
      );
    }
  }
);
