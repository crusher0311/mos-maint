import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken } from "@/lib/extension-auth";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const shopId = searchParams.get("shopId");
    const vin = searchParams.get("vin");
    const roId = searchParams.get("roId");

    if (!shopId) {
      return NextResponse.json(
        { error: "shopId is required" },
        { status: 400 }
      );
    }

    // Validate token AND shop access
    const auth = await validateExtensionToken(request, shopId);
    if (!auth.authorized) {
      const status = auth.error === "Unauthorized shop access" ? 403 : 401;
      return NextResponse.json({ error: auth.error }, { status });
    }

    const db = await getDb();

    // Get vehicle data if VIN provided
    let vehicle = null;
    let mileage = null;

    if (vin) {
      vehicle = await db.collection("vehicles").findOne({
        vin: vin.toUpperCase(),
        shopId: parseInt(shopId)
      });

      if (vehicle) {
        mileage = vehicle.currentMileage || vehicle.mileage;
      }
    }

    // Get cached maintenance analysis for this vehicle
    let analysisData = null;
    if (vin) {
      analysisData = await db.collection("maintenance_analysis_cache").findOne({
        vin: vin.toUpperCase(),
        shopId: parseInt(shopId)
      });
    }

    // Build plan response
    const plan = {
      overdue: [] as any[],
      dueSoon: [] as any[],
      recommended: [] as any[]
    };

    if (analysisData?.recommendations) {
      for (const rec of analysisData.recommendations) {
        const item = {
          name: rec.service || rec.name,
          dueAt: rec.dueMileage,
          interval: rec.interval,
          source: rec.source || "oe",
          priority: rec.priority,
          laborHours: rec.laborHours || 1,
          parts: rec.parts || []
        };

        if (rec.status === "overdue" || rec.isOverdue) {
          plan.overdue.push(item);
        } else if (rec.status === "due_soon" || rec.isDueSoon) {
          plan.dueSoon.push(item);
        } else {
          plan.recommended.push(item);
        }
      }
    }

    // If no cached analysis, try to get basic OEM schedule
    if (!analysisData && vehicle?.year && vehicle?.make && vehicle?.model) {
      const oeIntervals = await db.collection("oe_schedules").findOne({
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model
      });

      if (oeIntervals?.services) {
        for (const service of oeIntervals.services.slice(0, 10)) {
          plan.recommended.push({
            name: service.name || service.service,
            interval: service.interval,
            source: "oe"
          });
        }
      }
    }

    return NextResponse.json({
      vehicle: vehicle ? {
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        vin: vehicle.vin
      } : null,
      mileage,
      overdue: plan.overdue,
      dueSoon: plan.dueSoon,
      recommended: plan.recommended
    });

  } catch (error: any) {
    console.error("[Extension Plan] Error:", error);
    return NextResponse.json(
      { error: "Failed to load plan" },
      { status: 500 }
    );
  }
}
