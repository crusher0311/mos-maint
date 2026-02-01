import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createExternalEndpoint(
  "maintenance:read",
  async (req: NextRequest, { shopId }) => {
    const pathParts = req.nextUrl.pathname.split("/");
    const vin = pathParts[pathParts.length - 2];
    
    if (!vin || vin.length < 11) {
      return NextResponse.json(
        { error: "Valid VIN is required" },
        { status: 400 }
      );
    }
    
    const mileage = Number(req.nextUrl.searchParams.get("mileage")) || undefined;
    
    try {
      const { getOEMMaintenanceSchedule } = await import("@/lib/dataone");
      
      const schedule = await getOEMMaintenanceSchedule(vin, mileage);
      
      if (!schedule) {
        return NextResponse.json(
          { error: "Maintenance schedule not found for this VIN" },
          { status: 404 }
        );
      }
      
      return NextResponse.json({
        success: true,
        vin,
        mileage,
        schedule,
      });
      
    } catch (err: any) {
      console.error("[External API] Maintenance schedule error:", err);
      return NextResponse.json(
        { error: "Failed to fetch maintenance schedule", message: err.message },
        { status: 500 }
      );
    }
  }
);
