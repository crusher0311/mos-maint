import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { getRepairOrders, getVehicle, getCustomer, TekmetricRepairOrderFull, TekmetricVehicle, TekmetricCustomer } from "@/lib/tekmetric";

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

    for (const { vehicle, ro, customer } of vehicleMap.values()) {
      const vin = vehicle.vin!.toUpperCase();
      const existing = await db.collection("vehicles").findOne({ vin });
      
      // Get status and label from the full repair order structure
      const roStatus = ro.repairOrderStatus?.name || "Work-In-Progress";
      const roLabel = ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || null;
      const roLabelColor = ro.color || null;
      const roMileage = ro.milesIn || ro.milesOut || vehicle.mileageIn || vehicle.mileageOut;
      
      // Build the active source entry for this work order
      const workOrderSource = {
        provider: "tekmetric",
        workOrderId: String(ro.id),
        workOrderNumber: ro.repairOrderNumber,
        status: roStatus,
        addedAt: new Date(),
      };
      
      // Also upsert into tekmetric_work_orders (this is what the dashboard queries)
      const customerName = customer 
        ? `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || "Unknown Customer"
        : "Unknown Customer";
      
      await db.collection("tekmetric_work_orders").updateOne(
        { workOrderId: String(ro.id) },
        {
          $set: {
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
          $setOnInsert: {
            createdAt: new Date(),
          }
        },
        { upsert: true }
      );
      
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
          phone: customer.phone?.find(p => p.primary)?.number || customer.phone?.[0]?.number,
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
        // Update existing vehicle, add/update this work order source
        const existingSources = existing.status?.sources || [];
        const sourceIndex = existingSources.findIndex(
          (s: any) => s.provider === "tekmetric" && s.workOrderId === String(ro.id)
        );
        
        let updatedSources;
        if (sourceIndex >= 0) {
          // Update existing source
          updatedSources = [...existingSources];
          updatedSources[sourceIndex] = workOrderSource;
        } else {
          // Add new source
          updatedSources = [...existingSources, workOrderSource];
        }

        await db.collection("vehicles").updateOne(
          { vin },
          { 
            $set: {
              ...vehicleData,
              "status.active": true,
              "status.sources": updatedSources,
              "status.updatedAt": new Date(),
            }
          }
        );
        stats.vehiclesUpdated++;
      } else {
        await db.collection("vehicles").insertOne({
          ...vehicleData,
          shopId: shop._id,
          status: {
            active: true,
            sources: [workOrderSource],
            updatedAt: new Date(),
          },
          createdAt: new Date(),
        });
        stats.vehiclesImported++;
      }
    }

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
