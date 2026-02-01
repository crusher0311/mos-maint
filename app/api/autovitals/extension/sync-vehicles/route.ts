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

export async function POST(req: NextRequest) {
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
    const body = await req.json();
    
    const { vehicles, source, pageUrl, extractedAt } = body;

    if (!vehicles || !Array.isArray(vehicles) || vehicles.length === 0) {
      return NextResponse.json(
        { error: "No vehicles provided" },
        { status: 400 }
      );
    }

    const now = new Date();
    let importedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (const vehicle of vehicles) {
      const vin = vehicle.vin?.toUpperCase();
      
      if (!vin && !vehicle.customerName) {
        skippedCount++;
        continue;
      }

      const vehicleYear = vehicle.year ? parseInt(vehicle.year, 10) : null;
      const vehicleMake = vehicle.make || null;
      const vehicleModel = vehicle.model || null;
      let lastMileage = null;
      if (vehicle.mileage) {
        const mileageNum = parseInt(String(vehicle.mileage).replace(/\D/g, ''), 10);
        if (!isNaN(mileageNum) && mileageNum > 0) {
          lastMileage = mileageNum;
        }
      }
      const vehicleLicense = vehicle.licensePlate || null;
      const customerName = vehicle.customerName || null;
      const customerPhone = vehicle.customerPhone || null;
      const customerEmail = vehicle.customerEmail || null;
      const lastServiceDate = vehicle.lastServiceDate || null;
      const sourceValue = source || "autovitals";

      if (vin) {
        const result = await sql`
          INSERT INTO vehicles (shop_id, vin, year, make, model, last_mileage, license, customer_name, customer_phone, customer_email, last_service_date, source, updated_at, created_at)
          VALUES (${shopId}, ${vin}, ${vehicleYear}, ${vehicleMake}, ${vehicleModel}, ${lastMileage}, ${vehicleLicense}, ${customerName}, ${customerPhone}, ${customerEmail}, ${lastServiceDate}, ${sourceValue}, ${now}, ${now})
          ON CONFLICT (shop_id, vin) DO UPDATE SET
            year = COALESCE(EXCLUDED.year, vehicles.year),
            make = COALESCE(EXCLUDED.make, vehicles.make),
            model = COALESCE(EXCLUDED.model, vehicles.model),
            last_mileage = COALESCE(EXCLUDED.last_mileage, vehicles.last_mileage),
            license = COALESCE(EXCLUDED.license, vehicles.license),
            customer_name = COALESCE(EXCLUDED.customer_name, vehicles.customer_name),
            customer_phone = COALESCE(EXCLUDED.customer_phone, vehicles.customer_phone),
            customer_email = COALESCE(EXCLUDED.customer_email, vehicles.customer_email),
            last_service_date = COALESCE(EXCLUDED.last_service_date, vehicles.last_service_date),
            updated_at = EXCLUDED.updated_at
          RETURNING (xmax = 0) as inserted
        `;
        if (result[0]?.inserted) {
          importedCount++;
        } else {
          updatedCount++;
        }
      } else {
        skippedCount++;
      }
    }

    await sql`
      INSERT INTO autovitals_imports (shop_id, source, page_url, vehicles_received, vehicles_imported, vehicles_updated, vehicles_skipped, extracted_at, synced_at)
      VALUES (${shopId}, ${source || "autovitals"}, ${pageUrl || null}, ${vehicles.length}, ${importedCount}, ${updatedCount}, ${skippedCount}, ${extractedAt ? new Date(extractedAt) : now}, ${now})
    `;

    const totalVehiclesRows = await sql`
      SELECT COUNT(*)::int as count FROM vehicles WHERE shop_id = ${shopId} AND source = 'autovitals'
    `;
    const totalVehiclesImported = totalVehiclesRows[0]?.count || 0;

    await sql`
      UPDATE shops SET
        settings = jsonb_set(
          jsonb_set(
            COALESCE(settings, '{}'),
            '{autovitals,lastVehicleSyncAt}', ${JSON.stringify(now.toISOString())}::jsonb
          ),
          '{autovitals,totalVehiclesImported}', ${JSON.stringify(totalVehiclesImported)}::jsonb
        ),
        updated_at = ${now}
      WHERE id = ${shop.id}
    `;

    console.log(`[AutoVitals Extension] Synced ${vehicles.length} vehicles: ${importedCount} new, ${updatedCount} updated, ${skippedCount} skipped`);

    return NextResponse.json({
      ok: true,
      message: "Vehicles synced successfully",
      vehiclesReceived: vehicles.length,
      vehiclesImported: importedCount,
      vehiclesUpdated: updatedCount,
      vehiclesSkipped: skippedCount,
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Sync vehicles error:", error);
    return NextResponse.json(
      { error: error.message || "Sync failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}
