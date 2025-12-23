import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getRepairOrders, getVehicle, getCustomer, TekmetricRepairOrder, TekmetricVehicle, TekmetricCustomer } from "@/lib/tekmetric";

export async function POST(request: NextRequest) {
  try {
    const db = await getDb();

    const shop = await db.collection("shops").findOne({});
    if (!shop?.tekmetric?.shopId) {
      return NextResponse.json(
        { error: "Tekmetric not configured" },
        { status: 400 }
      );
    }

    const shopId = shop.tekmetric.shopId;
    const stats = {
      repairOrdersFound: 0,
      vehiclesImported: 0,
      vehiclesUpdated: 0,
      errors: [] as string[],
    };

    const activeStatuses = ['Estimate', 'Pending', 'In Progress', 'Complete'];
    const vehicleMap = new Map<number, { vehicle: TekmetricVehicle; ro: TekmetricRepairOrder; customer?: TekmetricCustomer }>();

    for (const status of activeStatuses) {
      let roPage = 0;
      let hasMore = true;

      while (hasMore) {
        try {
          const roResponse = await getRepairOrders(shopId, { 
            status, 
            page: roPage, 
            size: 100,
            sortDirection: 'DESC'
          });
          
          stats.repairOrdersFound += roResponse.content.length;

          for (const ro of roResponse.content) {
            if (!vehicleMap.has(ro.vehicleId)) {
              try {
                const vehicle = await getVehicle(ro.vehicleId);
                if (vehicle.vin) {
                  let customer: TekmetricCustomer | undefined;
                  try {
                    customer = await getCustomer(ro.customerId);
                  } catch (e) {
                  }
                  vehicleMap.set(ro.vehicleId, { vehicle, ro, customer });
                }
              } catch (error: any) {
                stats.errors.push(`Error fetching vehicle ${ro.vehicleId}: ${error.message}`);
              }
            }
          }

          hasMore = !roResponse.last;
          roPage++;
        } catch (error: any) {
          stats.errors.push(`Error fetching ${status} ROs page ${roPage}: ${error.message}`);
          hasMore = false;
        }
      }
    }

    for (const { vehicle, ro, customer } of vehicleMap.values()) {
      const vehicleData = {
        vin: vehicle.vin!.toUpperCase(),
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        subModel: vehicle.subModel,
        engine: vehicle.engine,
        transmission: vehicle.transmission,
        drivetrain: vehicle.drivetrain,
        licensePlate: vehicle.licensePlate,
        licensePlateState: vehicle.licensePlateState,
        color: vehicle.color,
        mileage: ro.mileageIn || ro.mileageOut || vehicle.mileageIn || vehicle.mileageOut,
        customer: customer ? {
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
          phone: customer.phone?.find(p => p.primary)?.number || customer.phone?.[0]?.number,
        } : undefined,
        tekmetric: {
          vehicleId: vehicle.id,
          customerId: vehicle.customerId,
          shopId: vehicle.shopId,
          repairOrderId: ro.id,
          repairOrderNumber: ro.repairOrderNumber,
          roStatus: ro.status,
          lastSynced: new Date(),
        },
        updatedAt: new Date(),
      };

      const existing = await db.collection("vehicles").findOne({ vin: vehicleData.vin });
      
      if (existing) {
        await db.collection("vehicles").updateOne(
          { vin: vehicleData.vin },
          { $set: vehicleData }
        );
        stats.vehiclesUpdated++;
      } else {
        await db.collection("vehicles").insertOne({
          ...vehicleData,
          createdAt: new Date(),
        });
        stats.vehiclesImported++;
      }
    }

    await db.collection("shops").updateOne(
      {},
      { $set: { "tekmetric.lastSync": new Date() } }
    );

    return NextResponse.json({
      success: true,
      stats,
    });
  } catch (error: any) {
    console.error("Tekmetric sync error:", error);
    return NextResponse.json(
      { error: error.message || "Sync failed" },
      { status: 500 }
    );
  }
}
