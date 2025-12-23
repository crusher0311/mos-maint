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

      const vehicleDoc: any = {
        shopId,
        source: source || "autovitals",
        updatedAt: now,
      };

      if (vin) vehicleDoc.vin = vin;
      if (vehicle.year) vehicleDoc.year = parseInt(vehicle.year, 10);
      if (vehicle.make) vehicleDoc.make = vehicle.make;
      if (vehicle.model) vehicleDoc.model = vehicle.model;
      if (vehicle.mileage) vehicleDoc.lastMileage = parseInt(String(vehicle.mileage).replace(/\D/g, ''), 10);
      if (vehicle.licensePlate) vehicleDoc.license = vehicle.licensePlate;
      
      if (vehicle.customerName || vehicle.customerPhone || vehicle.customerEmail) {
        vehicleDoc.customer = {
          name: vehicle.customerName || null,
          phone: vehicle.customerPhone || null,
          email: vehicle.customerEmail || null,
        };
      }

      if (vehicle.lastServiceDate) {
        vehicleDoc.lastServiceDate = vehicle.lastServiceDate;
      }

      const filter = vin 
        ? { shopId, vin }
        : { shopId, "customer.name": vehicle.customerName, make: vehicle.make, model: vehicle.model };

      const result = await db.collection("vehicles").updateOne(
        filter,
        {
          $set: vehicleDoc,
          $setOnInsert: {
            createdAt: now,
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
    });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Sync vehicles error:", error);
    return NextResponse.json(
      { error: error.message || "Sync failed" },
      { status: 500 }
    );
  }
}
