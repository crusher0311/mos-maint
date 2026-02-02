import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  try {
    const apiKey = req.headers.get("X-API-Key");
    
    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 401, headers: corsHeaders }
      );
    }

    const db = await getDb();
    
    const shop = await db.collection("shops").findOne({
      $or: [
        { autovitalsApiKey: apiKey },
        { "autovitalsExtension.apiKeys.value": apiKey }
      ]
    });

    if (!shop) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401, headers: corsHeaders }
      );
    }

    const shopId = shop.shopId;
    const vin = req.nextUrl.searchParams.get("vin")?.toUpperCase();

    if (!vin) {
      return NextResponse.json(
        { error: "VIN is required" },
        { status: 400 }
      );
    }

    const vehicle = await db.collection("vehicles").findOne({ shopId, vin });

    const recommendations = await db.collection("recommendations").find({
      shopId,
      vin,
    }).sort({ priority: 1 }).toArray();

    const formattedRecs = recommendations.map(rec => ({
      id: rec._id.toString(),
      name: rec.name || rec.serviceName,
      description: rec.description,
      source: rec.source || 'oem',
      priority: rec.priority || 'upcoming',
      dueDate: rec.dueDate,
      dueMileage: rec.dueMileage,
      notes: rec.notes,
    }));

    const oemScheduleDoc = await db.collection("oem_schedules").findOne({ vin });
    const oemSchedule = oemScheduleDoc?.items?.map((item: any) => ({
      name: item.name || item.serviceName,
      intervalMiles: item.intervalMiles,
      intervalMonths: item.intervalMonths,
      lastPerformed: item.lastPerformed,
      overdue: item.overdue,
      dueSoon: item.dueSoon,
    })) || [];

    const carfaxDoc = await db.collection("carfax_history").findOne({ vin });
    const carfaxHistory = carfaxDoc?.records?.map((record: any) => ({
      date: record.date,
      mileage: record.mileage,
      services: record.services || [],
      description: record.description,
    })) || [];

    const shopIdStr = String(shopId);
    
    const avVehicle = await db.collection("autovitals_vehicles").findOne({
      shopId: shopIdStr,
      vin: { $regex: new RegExp(`^${vin}$`, 'i') }
    });

    let dviResults: any[] = [];
    
    if (avVehicle?.vehicleId) {
      const latestAppointment = await db.collection("autovitals_appointments").findOne(
        { shopId: shopIdStr, vehicleId: avVehicle.vehicleId },
        { sort: { updatedAt: -1 } }
      );

      if (latestAppointment?.appointmentId) {
        const latestDvi = await db.collection("autovitals_inspections").findOne(
          { shopId: shopIdStr, appointmentId: latestAppointment.appointmentId },
          { sort: { updatedAt: -1 } }
        );

        if (latestDvi?.items) {
          dviResults = latestDvi.items.map((item: any) => ({
            name: item.name || item.Name,
            category: item.category || item.Category,
            status: item.status || (item.Status === 0 ? 'red' : item.Status === 1 ? 'yellow' : 'green'),
            notes: item.notes || item.techNotes,
            photos: item.photos || [],
          }));
        }
      }
    }

    return NextResponse.json({
      ok: true,
      vin,
      vehicle: vehicle ? {
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        lastMileage: vehicle.lastMileage,
        customer: vehicle.customer,
      } : null,
      recommendations: formattedRecs,
      oemSchedule,
      carfaxHistory,
      dviResults,
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Vehicle data error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch vehicle data" },
      { status: 500, headers: corsHeaders }
    );
  }
}
