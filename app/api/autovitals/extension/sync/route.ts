import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("X-API-Key");
    
    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 401 }
      );
    }

    const shopRows = await sql`
      SELECT id, shop_id, settings FROM shops 
      WHERE settings->>'autovitalsApiKey' = ${apiKey}
      LIMIT 1
    `;
    const shop = shopRows[0];

    if (!shop) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401 }
      );
    }

    const shopId = shop.shop_id;
    const body = await req.json();
    
    const { vehicle, inspection, source, extractedAt } = body;

    if (!vehicle?.vin && (!inspection?.results || inspection.results.length === 0)) {
      return NextResponse.json(
        { error: "No vehicle VIN or inspection data provided" },
        { status: 400 }
      );
    }

    const vin = vehicle?.vin?.toUpperCase();
    const now = new Date();

    if (vin) {
      const vehicleYear = vehicle.vehicleYear ? parseInt(vehicle.vehicleYear) : null;
      const vehicleMake = vehicle.vehicleMake || null;
      const vehicleModel = vehicle.vehicleModel || null;
      const vehicleLicense = vehicle.licensePlate || null;
      const lastMileage = vehicle.mileage ? parseInt(String(vehicle.mileage).replace(/\D/g, '')) : null;

      await sql`
        INSERT INTO vehicles (shop_id, vin, year, make, model, license, last_mileage, updated_at, created_at)
        VALUES (${shopId}, ${vin}, ${vehicleYear}, ${vehicleMake}, ${vehicleModel}, ${vehicleLicense}, ${lastMileage}, ${now}, ${now})
        ON CONFLICT (shop_id, vin) DO UPDATE SET
          year = COALESCE(EXCLUDED.year, vehicles.year),
          make = COALESCE(EXCLUDED.make, vehicles.make),
          model = COALESCE(EXCLUDED.model, vehicles.model),
          license = COALESCE(EXCLUDED.license, vehicles.license),
          last_mileage = COALESCE(EXCLUDED.last_mileage, vehicles.last_mileage),
          updated_at = EXCLUDED.updated_at
      `;
    }

    const inspectionDoc = {
      shopId,
      vin: vin || null,
      source: source || "autovitals",
      inspectionDate: inspection?.date ? new Date(inspection.date) : now,
      sourceUrl: inspection?.url || null,
      results: (inspection?.results || []).map((result: any) => ({
        id: result.id,
        description: result.description,
        status: result.status,
        notes: result.notes || "",
        pictures: result.pictures || [],
      })),
      extractedAt: extractedAt ? new Date(extractedAt) : now,
      syncedAt: now,
      customerName: vehicle?.customerName || null,
    };

    const insertRows = await sql`
      INSERT INTO autovitals_inspections (shop_id, vin, source, inspection_date, source_url, results, extracted_at, synced_at, customer_name)
      VALUES (${shopId}, ${inspectionDoc.vin}, ${inspectionDoc.source}, ${inspectionDoc.inspectionDate}, ${inspectionDoc.sourceUrl}, ${JSON.stringify(inspectionDoc.results)}::jsonb, ${inspectionDoc.extractedAt}, ${inspectionDoc.syncedAt}, ${inspectionDoc.customerName})
      RETURNING id
    `;
    const insertedId = insertRows[0]?.id;

    if (vin) {
      await sql`
        UPDATE vehicles SET
          last_dvi_date = ${now},
          last_dvi_source = 'autovitals',
          last_dvi_id = ${String(insertedId)}
        WHERE shop_id = ${shopId} AND vin = ${vin}
      `;
    }

    const countRows = await sql`
      SELECT COUNT(*)::int as count FROM autovitals_inspections WHERE shop_id = ${shopId}
    `;
    const totalInspections = countRows[0]?.count || 0;
    const immediateCount = (inspection?.results || []).filter((r: any) => r.status === "immediate").length;
    const cautionCount = (inspection?.results || []).filter((r: any) => r.status === "caution").length;

    await sql`
      UPDATE shops SET
        settings = jsonb_set(
          jsonb_set(
            COALESCE(settings, '{}'),
            '{autovitals,lastSyncAt}', ${JSON.stringify(now.toISOString())}::jsonb
          ),
          '{autovitals,totalInspections}', ${JSON.stringify(totalInspections)}::jsonb
        ),
        updated_at = ${now}
      WHERE id = ${shop.id}
    `;

    console.log(`[AutoVitals Extension] Synced inspection for VIN ${vin || 'unknown'}: ${inspection?.results?.length || 0} items`);

    return NextResponse.json({
      ok: true,
      message: "DVI data synced successfully",
      inspectionId: String(insertedId),
      itemsCount: inspection?.results?.length || 0,
      immediateCount,
      cautionCount,
    });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Sync error:", error);
    return NextResponse.json(
      { error: error.message || "Sync failed" },
      { status: 500 }
    );
  }
}
