import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

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

    const shopRows = await sql`
      SELECT id, shop_id, settings FROM shops 
      WHERE settings->>'autovitalsApiKey' = ${apiKey}
         OR settings->'autovitalsExtension'->'apiKeys' @> ${JSON.stringify([{ value: apiKey }])}::jsonb
      LIMIT 1
    `;
    const shop = shopRows[0];

    if (!shop) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401, headers: corsHeaders }
      );
    }

    const shopId = shop.shop_id;
    const vin = req.nextUrl.searchParams.get("vin")?.toUpperCase();

    if (!vin) {
      return NextResponse.json(
        { error: "VIN is required" },
        { status: 400 }
      );
    }

    const vehicleRows = await sql`
      SELECT * FROM vehicles WHERE shop_id = ${shopId} AND vin = ${vin} LIMIT 1
    `;
    const vehicle = vehicleRows[0];

    const recommendationRows = await sql`
      SELECT * FROM recommendations 
      WHERE shop_id = ${shopId} AND vin = ${vin}
      ORDER BY priority ASC
    `;

    const formattedRecs = recommendationRows.map((rec: any) => ({
      id: rec.id.toString(),
      name: rec.name || rec.service_name,
      description: rec.description,
      source: rec.source || 'oem',
      priority: rec.priority || 'upcoming',
      dueDate: rec.due_date,
      dueMileage: rec.due_mileage,
      notes: rec.notes,
    }));

    const oemScheduleRows = await sql`
      SELECT items FROM oem_schedules WHERE vin = ${vin} LIMIT 1
    `;
    const oemScheduleDoc = oemScheduleRows[0];
    const oemSchedule = oemScheduleDoc?.items?.map((item: any) => ({
      name: item.name || item.serviceName,
      intervalMiles: item.intervalMiles,
      intervalMonths: item.intervalMonths,
      lastPerformed: item.lastPerformed,
      overdue: item.overdue,
      dueSoon: item.dueSoon,
    })) || [];

    const carfaxRows = await sql`
      SELECT records FROM carfax_history WHERE vin = ${vin} LIMIT 1
    `;
    const carfaxDoc = carfaxRows[0];
    const carfaxHistory = carfaxDoc?.records?.map((record: any) => ({
      date: record.date,
      mileage: record.mileage,
      services: record.services || [],
      description: record.description,
    })) || [];

    const avVehicleRows = await sql`
      SELECT * FROM autovitals_vehicles 
      WHERE shop_id = ${shopId} AND UPPER(vin) = ${vin}
      LIMIT 1
    `;
    const avVehicle = avVehicleRows[0];

    let dviResults: any[] = [];
    
    if (avVehicle?.vehicle_id) {
      const latestAppointmentRows = await sql`
        SELECT * FROM autovitals_appointments 
        WHERE shop_id = ${shopId} AND vehicle_id = ${avVehicle.vehicle_id}
        ORDER BY updated_at DESC
        LIMIT 1
      `;
      const latestAppointment = latestAppointmentRows[0];

      if (latestAppointment?.appointment_id) {
        const latestDviRows = await sql`
          SELECT * FROM autovitals_inspections 
          WHERE shop_id = ${shopId} AND appointment_id = ${latestAppointment.appointment_id}
          ORDER BY updated_at DESC
          LIMIT 1
        `;
        const latestDvi = latestDviRows[0];

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
        lastMileage: vehicle.last_mileage,
        customer: {
          name: vehicle.customer_name,
          phone: vehicle.customer_phone,
          email: vehicle.customer_email,
        },
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
