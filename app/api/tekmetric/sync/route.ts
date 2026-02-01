import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";
import { getRepairOrders, getVehicle, getCustomer, TekmetricRepairOrderFull, TekmetricVehicle, TekmetricCustomer } from "@/lib/tekmetric";

async function getUserShopId(): Promise<string | null> {
  const store = await cookies();
  const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
  if (!sid) return null;

  const sessRows = await sql`
    SELECT user_id FROM sessions WHERE token = ${sid} AND expires_at > NOW()
  `;
  const sess = sessRows[0] as any;
  if (!sess) return null;

  const userRows = await sql`SELECT shop_id FROM users WHERE id = ${sess.user_id}`;
  const user = userRows[0] as any;
  return user?.shop_id ? String(user.shop_id) : null;
}

export async function POST(request: NextRequest) {
  try {
    const userShopId = await getUserShopId();
    if (!userShopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${String(userShopId)}`;
    const shop = shopRows[0] as any;
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
      const existingRows = await sql`SELECT * FROM vehicles WHERE vin = ${vin}`;
      const existing = existingRows[0] as any;
      
      const roStatus = ro.repairOrderStatus?.name || "Work-In-Progress";
      const roLabel = ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || null;
      const roLabelColor = ro.color || null;
      const roMileage = ro.milesIn || ro.milesOut || vehicle.mileageIn || vehicle.mileageOut;
      
      if (vehicleMap.size <= 3) {
        console.log(`[Tekmetric Sync] Sample RO #${ro.repairOrderNumber}: status="${roStatus}", vin=${vin}, mileage=${roMileage}`);
      }
      
      const workOrderSource = {
        provider: "tekmetric",
        workOrderId: String(ro.id),
        workOrderNumber: ro.repairOrderNumber,
        status: roStatus,
        addedAt: new Date().toISOString(),
      };
      
      const customerName = customer 
        ? `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || "Unknown Customer"
        : "Unknown Customer";
      
      await sql`
        INSERT INTO tekmetric_work_orders (
          work_order_id, work_order_number, shop_id, tekmetric_shop_id, vin,
          vehicle_year, vehicle_make, vehicle_model, vehicle_engine, customer_name,
          customer_id, odometer, status, label, label_color, fetched_at, updated_at, created_at
        ) VALUES (
          ${String(ro.id)}, ${String(ro.repairOrderNumber)}, ${String(userShopId)}, ${shopId}, ${vin},
          ${vehicle.year}, ${vehicle.make}, ${vehicle.model}, ${vehicle.engine}, ${customerName},
          ${ro.customerId}, ${roMileage}, ${roStatus}, ${roLabel}, ${roLabelColor}, NOW(), NOW(), NOW()
        )
        ON CONFLICT (work_order_id) DO UPDATE SET
          work_order_number = EXCLUDED.work_order_number,
          shop_id = EXCLUDED.shop_id,
          tekmetric_shop_id = EXCLUDED.tekmetric_shop_id,
          vin = EXCLUDED.vin,
          vehicle_year = EXCLUDED.vehicle_year,
          vehicle_make = EXCLUDED.vehicle_make,
          vehicle_model = EXCLUDED.vehicle_model,
          vehicle_engine = EXCLUDED.vehicle_engine,
          customer_name = EXCLUDED.customer_name,
          customer_id = EXCLUDED.customer_id,
          odometer = EXCLUDED.odometer,
          status = EXCLUDED.status,
          label = EXCLUDED.label,
          label_color = EXCLUDED.label_color,
          fetched_at = NOW(),
          updated_at = NOW()
      `;

      const tekmetricData = {
        vehicleId: vehicle.id,
        customerId: vehicle.customerId,
        shopId: vehicle.shopId,
        repairOrderId: ro.id,
        repairOrderNumber: ro.repairOrderNumber,
        roStatus: roStatus,
        roLabel: roLabel,
        roLabelColor: roLabelColor,
        lastSynced: new Date().toISOString(),
      };

      const customerData = customer ? {
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone?.find(p => p.primary)?.number || customer.phone?.[0]?.number,
      } : null;
      
      if (existing) {
        const existingSources = existing.status?.sources || [];
        const sourceIndex = existingSources.findIndex(
          (s: any) => s.provider === "tekmetric" && s.workOrderId === String(ro.id)
        );
        
        let updatedSources;
        if (sourceIndex >= 0) {
          updatedSources = [...existingSources];
          updatedSources[sourceIndex] = workOrderSource;
        } else {
          updatedSources = [...existingSources, workOrderSource];
        }

        const statusData = {
          active: true,
          sources: updatedSources,
          updatedAt: new Date().toISOString(),
        };

        await sql`
          UPDATE vehicles SET
            year = COALESCE(${vehicle.year}, year),
            make = COALESCE(${vehicle.make}, make),
            model = COALESCE(${vehicle.model}, model),
            sub_model = COALESCE(${vehicle.subModel}, sub_model),
            engine = COALESCE(${vehicle.engine}, engine),
            transmission = COALESCE(${vehicle.transmission}, transmission),
            drivetrain = COALESCE(${vehicle.drivetrain}, drivetrain),
            license_plate = COALESCE(${vehicle.licensePlate}, license_plate),
            license_plate_state = COALESCE(${vehicle.licensePlateState}, license_plate_state),
            color = COALESCE(${vehicle.color}, color),
            last_mileage = COALESCE(${roMileage}, last_mileage),
            customer = COALESCE(${customerData ? JSON.stringify(customerData) : null}::jsonb, customer),
            tekmetric = ${JSON.stringify(tekmetricData)}::jsonb,
            status = ${JSON.stringify(statusData)}::jsonb,
            updated_at = NOW()
          WHERE vin = ${vin}
        `;
        stats.vehiclesUpdated++;
      } else {
        const statusData = {
          active: true,
          sources: [workOrderSource],
          updatedAt: new Date().toISOString(),
        };

        await sql`
          INSERT INTO vehicles (
            vin, shop_id, year, make, model, sub_model, engine, transmission, drivetrain,
            license_plate, license_plate_state, color, last_mileage, customer, tekmetric, status,
            created_at, updated_at
          ) VALUES (
            ${vin}, ${String(userShopId)}, ${vehicle.year}, ${vehicle.make}, ${vehicle.model},
            ${vehicle.subModel}, ${vehicle.engine}, ${vehicle.transmission}, ${vehicle.drivetrain},
            ${vehicle.licensePlate}, ${vehicle.licensePlateState}, ${vehicle.color}, ${roMileage},
            ${customerData ? JSON.stringify(customerData) : null}::jsonb,
            ${JSON.stringify(tekmetricData)}::jsonb,
            ${JSON.stringify(statusData)}::jsonb,
            NOW(), NOW()
          )
        `;
        stats.vehiclesImported++;
      }
    }

    await sql`
      UPDATE shops SET
        tekmetric = jsonb_set(COALESCE(tekmetric, '{}')::jsonb, '{lastSync}', ${JSON.stringify(new Date().toISOString())}::jsonb),
        updated_at = NOW()
      WHERE shop_id = ${String(userShopId)}
    `;

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
