import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const apiKey = req.headers.get("X-API-Key");
    
    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 401 }
      );
    }

    const db = await getDb();
    
    const shop = await db.collection("shops").findOne({
      "autovitalsExtension.apiKeys.value": apiKey
    });

    if (!shop) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401 }
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

    const latestDvi = await db.collection("autovitals_inspections").findOne(
      { shopId, vin },
      { sort: { syncedAt: -1 } }
    );
    
    const dviResults = latestDvi?.results?.map((result: any) => ({
      description: result.description,
      status: result.status,
      notes: result.notes,
      pictures: result.pictures || [],
    })) || [];

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
    });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Vehicle data error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch vehicle data" },
      { status: 500 }
    );
  }
}
