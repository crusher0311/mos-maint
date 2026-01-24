import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { getRepairOrders, getVehicle, getCustomer, TekmetricRepairOrder, TekmetricVehicle, TekmetricCustomer } from "@/lib/tekmetric";

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
      const vin = vehicle.vin!.toUpperCase();
      const existing = await db.collection("vehicles").findOne({ vin });
      
      // Build the active source entry for this work order
      const workOrderSource = {
        provider: "tekmetric",
        workOrderId: String(ro.id),
        workOrderNumber: ro.repairOrderNumber,
        status: ro.status || "Open",
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
          roLabel: ro.label?.text || null,
          roLabelColor: ro.label?.colorCode || null,
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
