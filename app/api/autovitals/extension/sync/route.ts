import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

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

    const db = await getDb();
    
    const shop = await db.collection("shops").findOne({
      autovitalsApiKey: apiKey
    });

    if (!shop) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401 }
      );
    }

    const shopId = shop.shopId;
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
      await db.collection("vehicles").updateOne(
        { shopId, vin },
        {
          $set: {
            year: vehicle.vehicleYear ? parseInt(vehicle.vehicleYear) : undefined,
            make: vehicle.vehicleMake,
            model: vehicle.vehicleModel,
            license: vehicle.licensePlate,
            lastMileage: vehicle.mileage ? parseInt(vehicle.mileage.replace(/\D/g, '')) : undefined,
            updatedAt: now,
          },
          $setOnInsert: {
            shopId,
            vin,
            createdAt: now,
          }
        },
        { upsert: true }
      );
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

    const insertResult = await db.collection("autovitals_inspections").insertOne(inspectionDoc);

    if (vin) {
      await db.collection("vehicles").updateOne(
        { shopId, vin },
        {
          $set: {
            lastDviDate: now,
            lastDviSource: "autovitals",
            lastDviId: insertResult.insertedId,
          }
        }
      );
    }

    const totalInspections = await db.collection("autovitals_inspections").countDocuments({ shopId });
    const immediateCount = (inspection?.results || []).filter((r: any) => r.status === "immediate").length;
    const cautionCount = (inspection?.results || []).filter((r: any) => r.status === "caution").length;

    await db.collection("shops").updateOne(
      { _id: shop._id },
      {
        $set: {
          "autovitals.lastSyncAt": now,
          "autovitals.totalInspections": totalInspections,
          updatedAt: now,
        }
      }
    );

    console.log(`[AutoVitals Extension] Synced inspection for VIN ${vin || 'unknown'}: ${inspection?.results?.length || 0} items`);

    return NextResponse.json({
      ok: true,
      message: "DVI data synced successfully",
      inspectionId: insertResult.insertedId.toString(),
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
