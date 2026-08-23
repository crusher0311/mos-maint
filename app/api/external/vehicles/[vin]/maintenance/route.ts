import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { classifyMaintenanceScheduleFailure } from "@/lib/external-api/maintenance-schedule";

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
      const { getMaintenanceSchedule } = await import("@/lib/integrations/dataone-api");
      
      const schedule = await getMaintenanceSchedule(vin);

      const failure = classifyMaintenanceScheduleFailure(schedule);
      if (failure) {
        return NextResponse.json(
          {
            error:
              failure.status === 404
                ? "Maintenance schedule not found for this VIN"
                : "Failed to fetch maintenance schedule",
            message: failure.error,
          },
          { status: failure.status },
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
