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

export async function POST(req: NextRequest) {
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

      const setFields: any = {
        shopId,
        updatedAt: now,
      };
      
      if (vin) setFields.vin = vin;
      if (vehicle.year) setFields.year = parseInt(vehicle.year, 10);
      if (vehicle.make) setFields.make = vehicle.make;
      if (vehicle.model) setFields.model = vehicle.model;
      if (vehicle.mileage) {
        const mileage = parseInt(String(vehicle.mileage).replace(/\D/g, ''), 10);
        if (!isNaN(mileage) && mileage > 0) {
          setFields.lastMileage = mileage;
        }
      }
      if (vehicle.licensePlate) setFields.license = vehicle.licensePlate;
      
      if (vehicle.customerName) setFields["customer.name"] = vehicle.customerName;
      if (vehicle.customerPhone) setFields["customer.phone"] = vehicle.customerPhone;
      if (vehicle.customerEmail) setFields["customer.email"] = vehicle.customerEmail;

      if (vehicle.lastServiceDate) {
        setFields.lastServiceDate = vehicle.lastServiceDate;
      }

      const filter = vin 
        ? { shopId, vin }
        : { shopId, "customer.name": vehicle.customerName, make: vehicle.make, model: vehicle.model };

      const result = await db.collection("vehicles").updateOne(
        filter,
        {
          $set: setFields,
          $setOnInsert: {
            createdAt: now,
            source: source || "autovitals",
          }
        },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        importedCount++;
      } else if (result.modifiedCount > 0) {
        updatedCount++;
      }
    }

    await db.collection("autovitals_imports").insertOne({
      shopId,
      source: source || "autovitals",
      pageUrl,
      vehiclesReceived: vehicles.length,
      vehiclesImported: importedCount,
      vehiclesUpdated: updatedCount,
      vehiclesSkipped: skippedCount,
      extractedAt: extractedAt ? new Date(extractedAt) : now,
      syncedAt: now,
    });

    await db.collection("shops").updateOne(
      { _id: shop._id },
      {
        $set: {
          "autovitals.lastVehicleSyncAt": now,
          "autovitals.totalVehiclesImported": await db.collection("vehicles").countDocuments({ 
            shopId, 
            source: "autovitals" 
          }),
          updatedAt: now,
        }
      }
    );

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
