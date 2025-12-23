import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import {
  getShopAutoVitalsConfig,
  getAppointmentUpdates,
  getVehicle,
  getInspectionResults,
  cacheAutoVitalsVehicle,
  cacheAutoVitalsInspection,
} from "@/lib/integrations/autovitals";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const shopId = String(session.shopId);
    const numericShopId = parseInt(shopId, 10);

    const config = await getShopAutoVitalsConfig(shopId);
    if (!config) {
      return NextResponse.json({ 
        error: "AutoVitals is not configured. Please set up your credentials in Settings." 
      }, { status: 400 });
    }

    console.log(`[AutoVitals Bulk Sync] Starting for shop ${shopId}`);

    const db = await getDb();
    const now = new Date();

    const appointmentsResult = await getAppointmentUpdates(config);
    if (!appointmentsResult.ok) {
      return NextResponse.json({ 
        error: `Failed to fetch appointments: ${appointmentsResult.error}` 
      }, { status: 500 });
    }

    const appointments = appointmentsResult.data;
    console.log(`[AutoVitals Bulk Sync] Found ${appointments.length} appointments`);

    let vehiclesSynced = 0;
    let vehiclesImported = 0;
    let inspectionsSynced = 0;
    let enrichmentQueued = 0;
    const errors: string[] = [];
    const processedVins = new Set<string>();

    for (const appointment of appointments) {
      try {
        if (appointment.vehicleId) {
          const vehicleResult = await getVehicle(appointment.vehicleId, config);
          if (vehicleResult.ok) {
            const avVehicle = vehicleResult.data;
            
            await cacheAutoVitalsVehicle(avVehicle, shopId);
            vehiclesSynced++;

            if (avVehicle.vin && !processedVins.has(avVehicle.vin)) {
              processedVins.add(avVehicle.vin);
              
              const customerName = avVehicle.customerName || appointment.customerName;
              const customerPhone = appointment.customerPhone;
              const customerEmail = appointment.customerEmail;

              const existingVehicle = await db.collection("vehicles").findOne({
                shopId: numericShopId,
                vin: avVehicle.vin.toUpperCase()
              });

              const vehicleData: any = {
                shopId: numericShopId,
                vin: avVehicle.vin.toUpperCase(),
                year: avVehicle.year,
                make: avVehicle.make,
                model: avVehicle.model,
                lastMileage: avVehicle.mileage || appointment.mileageIn,
                license: avVehicle.licensePlate,
                source: "autovitals",
                updatedAt: now,
              };

              if (customerName) {
                vehicleData["customer.name"] = customerName;
              }
              if (customerPhone) {
                vehicleData["customer.phone"] = customerPhone;
              }
              if (customerEmail) {
                vehicleData["customer.email"] = customerEmail;
              }

              await db.collection("vehicles").updateOne(
                { shopId: numericShopId, vin: avVehicle.vin.toUpperCase() },
                {
                  $set: vehicleData,
                  $setOnInsert: { createdAt: now }
                },
                { upsert: true }
              );

              if (!existingVehicle) {
                vehiclesImported++;
              }

              const needsEnrichment = !existingVehicle || 
                !existingVehicle.oemScheduleFetchedAt ||
                !existingVehicle.carfaxFetchedAt;

              if (needsEnrichment) {
                await db.collection("enrichment_queue").updateOne(
                  { shopId: numericShopId, vin: avVehicle.vin.toUpperCase() },
                  {
                    $set: {
                      shopId: numericShopId,
                      vin: avVehicle.vin.toUpperCase(),
                      status: "pending",
                      priority: 1,
                      updatedAt: now,
                    },
                    $setOnInsert: {
                      createdAt: now,
                      attempts: 0,
                    }
                  },
                  { upsert: true }
                );
                enrichmentQueued++;
              }
            }
          }
        }

        if (appointment.appointmentId) {
          const inspectionResult = await getInspectionResults(appointment.appointmentId, config);
          if (inspectionResult.ok && inspectionResult.data.items.length > 0) {
            await cacheAutoVitalsInspection(inspectionResult.data, shopId);
            inspectionsSynced++;

            if (appointment.vin) {
              await db.collection("vehicles").updateOne(
                { shopId: numericShopId, vin: appointment.vin.toUpperCase() },
                {
                  $set: {
                    lastDviAt: now,
                    lastDviAppointmentId: appointment.appointmentId,
                    "dvi.itemCount": inspectionResult.data.items.length,
                    "dvi.redCount": inspectionResult.data.items.filter(i => i.status === "red").length,
                    "dvi.yellowCount": inspectionResult.data.items.filter(i => i.status === "yellow").length,
                  }
                }
              );
            }
          }
        }
      } catch (err) {
        const msg = `Failed to sync appointment ${appointment.appointmentId}: ${err}`;
        console.error(`[AutoVitals Bulk Sync] ${msg}`);
        errors.push(msg);
      }
    }

    await db.collection("shops").updateOne(
      { shopId: numericShopId },
      {
        $set: {
          "autovitals.lastBulkSyncAt": now,
          "autovitals.lastBulkSyncStats": {
            appointments: appointments.length,
            vehiclesSynced,
            vehiclesImported,
            inspectionsSynced,
            enrichmentQueued,
          },
          updatedAt: now,
        }
      }
    );

    console.log(`[AutoVitals Bulk Sync] Completed. Vehicles: ${vehiclesSynced} synced, ${vehiclesImported} imported. Inspections: ${inspectionsSynced}. Enrichment queued: ${enrichmentQueued}`);

    return NextResponse.json({
      success: true,
      stats: {
        appointments: appointments.length,
        vehiclesSynced,
        vehiclesImported,
        inspectionsSynced,
        enrichmentQueued,
        errors: errors.length,
      },
      message: `Synced ${vehiclesSynced} vehicles from AutoVitals. ${vehiclesImported} new vehicles imported to MOS.`,
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
    });
  } catch (error) {
    console.error("[AutoVitals Bulk Sync] Error:", error);
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : "Sync failed" 
    }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const shopId = parseInt(String(session.shopId), 10);

    const db = await getDb();

    const avVehicleCount = await db.collection("autovitals_vehicles").countDocuments({ shopId: String(shopId) });
    const mosVehicleCount = await db.collection("vehicles").countDocuments({ shopId, source: "autovitals" });
    const pendingEnrichment = await db.collection("enrichment_queue").countDocuments({ shopId, status: "pending" });

    const shop = await db.collection("shops").findOne({ shopId });

    return NextResponse.json({
      autovitalsVehicles: avVehicleCount,
      mosVehicles: mosVehicleCount,
      pendingEnrichment,
      lastBulkSyncAt: shop?.autovitals?.lastBulkSyncAt || null,
      lastBulkSyncStats: shop?.autovitals?.lastBulkSyncStats || null,
    });
  } catch (error) {
    console.error("[AutoVitals Bulk Sync GET] Error:", error);
    return NextResponse.json({ error: "Failed to fetch sync status" }, { status: 500 });
  }
}
