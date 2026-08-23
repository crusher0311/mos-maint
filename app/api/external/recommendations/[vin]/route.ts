import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";
import {
  getRecommendationsCacheDoc,
  upsertRecommendationsCacheDoc,
} from "@/lib/data/repositories/plan-cache-store";

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
    
    const db = await getDb();
    
    try {
      // Task #998: flag-dispatched PG/Mongo facade read.
      const cachedRecs = await getRecommendationsCacheDoc(shopId, vin, db);
      
      if (cachedRecs && !includeAI) {
        const cacheAge = Date.now() - new Date(cachedRecs.updatedAt as string | number | Date).getTime();
        const maxAge = 24 * 60 * 60 * 1000;
        
        if (cacheAge < maxAge) {
          return NextResponse.json({
            success: true,
            vin,
            source: "cache",
            recommendations: cachedRecs.recommendations,
            cachedAt: cachedRecs.updatedAt,
          });
        }
      }
      
      const { getMaintenanceRecommendations } = await import("@/lib/recommendations");
      
      const recommendations = await getMaintenanceRecommendations(vin, {
        shopId: String(shopId),
        mileage,
        includeAI,
      });
      
      await upsertRecommendationsCacheDoc(shopId, vin, recommendations, db);
      
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
