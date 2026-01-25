import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { getRepairOrders, getVehicle, getCustomer, TekmetricRepairOrderFull, TekmetricVehicle, TekmetricCustomer } from "@/lib/integrations/tekmetric";
import { bulkUpsert, parallelBatchProcess } from "@/lib/batch-operations";

async function getUserShopId(): Promise<string | null> {
  const store = await cookies();
  const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
  if (!sid) return null;

  const db = await getDb();
  const now = new Date();
  const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: now } });
  if (!sess) return null;

  const user = await db.collection("users").findOne({ _id: sess.userId });
  return user?.shopId ? String(user.shopId) : null;
}

export async function POST(request: NextRequest) {
  try {
    const db = await getDb();

    const userShopId = await getUserShopId();
    if (!userShopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shop = await db.collection("shops").findOne({
      shopId: { $in: [userShopId, Number(userShopId)] }
    });
    if (!shop?.tekmetric?.shopId) {
      return NextResponse.json(
        { error: "Tekmetric not configured for your shop" },
        { status: 400 }
      );
    }

    const shopId = shop.tekmetric.shopId;
    console.log(`[Tekmetric Sync] Starting sync for shop ${userShopId}, Tekmetric shopId: ${shopId}`);
    
    const stats = {
      repairOrdersFound: 0,
      vehiclesImported: 0,
      vehiclesUpdated: 0,
      errors: [] as string[],
    };

    const activeStatuses = ['Estimate', 'Pending', 'In Progress', 'Complete'];
    const vehicleMap = new Map<number, { vehicle: TekmetricVehicle; ro: TekmetricRepairOrderFull; customer?: TekmetricCustomer }>();

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

    // Batch 1: Collect all VINs and fetch existing vehicles in one query
    const allVins = [...vehicleMap.values()].map(v => v.vehicle.vin!.toUpperCase());
    const existingVehicles = await db.collection("vehicles")
      .find({ vin: { $in: allVins } })
      .project({ vin: 1, status: 1 })
      .toArray();
    const existingVehicleMap = new Map(existingVehicles.map(v => [v.vin, v]));

    // Batch 2: Prepare bulk upsert for tekmetric_work_orders
    const workOrderUpserts = [...vehicleMap.values()].map(({ vehicle, ro, customer }) => {
      const vin = vehicle.vin!.toUpperCase();
      const roStatus = ro.repairOrderStatus?.name || "Work-In-Progress";
      const roLabel = ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || null;
      const roLabelColor = ro.color || null;
      const roMileage = ro.milesIn || ro.milesOut || vehicle.mileageIn || vehicle.mileageOut;
      const customerName = customer 
        ? `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || "Unknown Customer"
        : "Unknown Customer";

      return {
        filter: { workOrderId: String(ro.id) },
        update: {
          workOrderId: String(ro.id),
          workOrderNumber: ro.repairOrderNumber,
          shopId: String(userShopId),
          tekmetricShopId: shopId,
          vin,
          vehicleYear: vehicle.year,
          vehicleMake: vehicle.make,
          vehicleModel: vehicle.model,
          vehicleEngine: vehicle.engine,
          customerName,
          customerId: ro.customerId,
          odometer: roMileage,
          status: roStatus,
          label: roLabel,
          labelColor: roLabelColor,
          fetchedAt: new Date(),
          updatedAt: new Date(),
        },
        setOnInsert: { createdAt: new Date() },
      };
    });

    await bulkUpsert('tekmetric_work_orders', workOrderUpserts);

    // Batch 3: Prepare bulk operations for vehicles
    const vehicleUpserts = [...vehicleMap.values()].map(({ vehicle, ro, customer }) => {
      const vin = vehicle.vin!.toUpperCase();
      const existing = existingVehicleMap.get(vin);
      const roStatus = ro.repairOrderStatus?.name || "Work-In-Progress";
      const roLabel = ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || null;
      const roLabelColor = ro.color || null;
      const roMileage = ro.milesIn || ro.milesOut || vehicle.mileageIn || vehicle.mileageOut;

      const workOrderSource = {
        provider: "tekmetric",
        workOrderId: String(ro.id),
        workOrderNumber: ro.repairOrderNumber,
        status: roStatus,
        addedAt: new Date(),
      };

      const vehicleData: Record<string, any> = {
        vin,
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
        mileage: roMileage,
        customer: customer ? {
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
          phone: customer.phone?.find((p: any) => p.primary)?.number || customer.phone?.[0]?.number,
        } : undefined,
        tekmetric: {
          vehicleId: vehicle.id,
          customerId: vehicle.customerId,
          shopId: vehicle.shopId,
          repairOrderId: ro.id,
          repairOrderNumber: ro.repairOrderNumber,
          roStatus: roStatus,
          roLabel: roLabel,
          roLabelColor: roLabelColor,
          lastSynced: new Date(),
        },
        updatedAt: new Date(),
      };

      if (existing) {
        const existingSources = existing.status?.sources || [];
        const sourceIndex = existingSources.findIndex(
          (s: any) => s.provider === "tekmetric" && s.workOrderId === String(ro.id)
        );
        let updatedSources = sourceIndex >= 0
          ? existingSources.map((s: any, i: number) => i === sourceIndex ? workOrderSource : s)
          : [...existingSources, workOrderSource];

        stats.vehiclesUpdated++;
        return {
          filter: { vin },
          update: {
            ...vehicleData,
            "status.active": true,
            "status.sources": updatedSources,
            "status.updatedAt": new Date(),
          },
        };
      } else {
        stats.vehiclesImported++;
        return {
          filter: { vin },
          update: {
            ...vehicleData,
            shopId: shop._id,
            "status.active": true,
            "status.sources": [workOrderSource],
            "status.updatedAt": new Date(),
          },
          setOnInsert: { createdAt: new Date() },
        };
      }
    });

    await bulkUpsert('vehicles', vehicleUpserts);

    await db.collection("shops").updateOne(
      { shopId: { $in: [userShopId, Number(userShopId)] } },
      { $set: { "tekmetric.lastSync": new Date() } }
    );

    console.log(`[Tekmetric Sync] Complete - ROs: ${stats.repairOrdersFound}, Imported: ${stats.vehiclesImported}, Updated: ${stats.vehiclesUpdated}, Errors: ${stats.errors.length}`);
    if (stats.errors.length > 0) {
      console.log(`[Tekmetric Sync] Errors:`, stats.errors.slice(0, 5));
    }

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
