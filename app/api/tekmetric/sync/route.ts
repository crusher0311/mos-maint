import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getVehicles, getCustomers, TekmetricCustomer } from "@/lib/tekmetric";

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
      vehiclesImported: 0,
      vehiclesUpdated: 0,
      customersImported: 0,
      errors: [] as string[],
    };

    const customerMap = new Map<number, TekmetricCustomer>();
    let customerPage = 0;
    let hasMoreCustomers = true;

    while (hasMoreCustomers) {
      try {
        const customersResponse = await getCustomers(shopId, { page: customerPage, size: 100 });
        for (const customer of customersResponse.content) {
          customerMap.set(customer.id, customer);
        }
        hasMoreCustomers = !customersResponse.last;
        customerPage++;
      } catch (error: any) {
        stats.errors.push(`Error fetching customers page ${customerPage}: ${error.message}`);
        hasMoreCustomers = false;
      }
    }

    stats.customersImported = customerMap.size;

    let vehiclePage = 0;
    let hasMoreVehicles = true;

    while (hasMoreVehicles) {
      try {
        const vehiclesResponse = await getVehicles(shopId, { page: vehiclePage, size: 100 });

        for (const vehicle of vehiclesResponse.content) {
          if (!vehicle.vin) continue;

          const customer = customerMap.get(vehicle.customerId);

          const vehicleData = {
            vin: vehicle.vin,
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
            mileage: vehicle.mileageIn || vehicle.mileageOut,
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
              lastSynced: new Date(),
            },
            updatedAt: new Date(),
          };

          const existing = await db.collection("vehicles").findOne({ vin: vehicle.vin });
          
          if (existing) {
            await db.collection("vehicles").updateOne(
              { vin: vehicle.vin },
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

        hasMoreVehicles = !vehiclesResponse.last;
        vehiclePage++;
      } catch (error: any) {
        stats.errors.push(`Error fetching vehicles page ${vehiclePage}: ${error.message}`);
        hasMoreVehicles = false;
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
