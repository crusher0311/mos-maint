import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { indexTekmetricWorkOrderJobs } from "@/lib/tekmetric-job-index";
import { getVehicle, getCustomer } from "@/lib/tekmetric";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL_STATUSES = ["invoice", "invoiced", "posted", "deleted", "void", "closed"];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    
    console.log("[Tekmetric Webhook] Received event:", JSON.stringify(body, null, 2).slice(0, 1000));
    
    const eventType = body.event || body.eventType || body.type || "";
    const data = body.data || body.payload || body;
    
    const repairOrder = data.repairOrder || body.repairOrder || 
      (data.id && data.repairOrderNumber && data.shopId ? data : null);
    
    const isInspectionComplete = 
      eventType.toLowerCase().includes("inspection") && 
      (eventType.toLowerCase().includes("complete") || eventType.toLowerCase().includes("marked complete"));
    
    const isCustomerViewed = 
      eventType.toLowerCase().includes("customer") && 
      eventType.toLowerCase().includes("viewed");
    
    const isRepairOrderUpdate = 
      eventType.toLowerCase().includes("repairorder") ||
      eventType.toLowerCase().includes("repair_order") ||
      eventType.toLowerCase().includes("ro.") ||
      repairOrder;
    
    const isInvoicePosted = 
      eventType.toLowerCase().includes("posted") ||
      eventType.toLowerCase().includes("invoiced") ||
      eventType.toLowerCase().includes("invoice");
    
    console.log(`[Tekmetric Webhook] Parsed - eventType: "${eventType}", repairOrder found: ${!!repairOrder}, isRepairOrderUpdate: ${isRepairOrderUpdate}`);
    
    if (repairOrder) {
      const roId = repairOrder.id;
      const roNumber = repairOrder.repairOrderNumber;
      const tekmetricShopId = repairOrder.shopId;
      const statusName = repairOrder.repairOrderStatus?.name || "";
      const statusCode = repairOrder.repairOrderStatus?.code || "";
      
      console.log(`[Tekmetric Webhook] RO Update: #${roNumber} (ID: ${roId}), Status: ${statusName} (${statusCode})`);
      
      const isTerminal = TERMINAL_STATUSES.some(s => 
        statusName.toLowerCase().includes(s) || 
        statusCode.toLowerCase().includes(s)
      );
      
      if (isTerminal || isInvoicePosted) {
        console.log(`[Tekmetric Webhook] RO #${roNumber} is terminal/invoiced, updating cache immediately`);
        
        const cachedRows = await sql`
          SELECT * FROM tekmetric_work_orders WHERE work_order_id = ${String(roId)}
        `;
        const cached = cachedRows[0] as any;
        
        if (cached && !cached.jobs_indexed && cached.vin) {
          const shopRows = await sql`
            SELECT * FROM shops WHERE tekmetric_shop_id = ${String(tekmetricShopId)}
          `;
          const shop = shopRows[0] as any;
          
          if (shop) {
            try {
              const jobsIndexed = await indexTekmetricWorkOrderJobs(
                Number(shop.shop_id),
                tekmetricShopId,
                roId,
                roNumber,
                {
                  vin: cached.vin,
                  year: cached.vehicle_year,
                  make: cached.vehicle_make,
                  model: cached.vehicle_model,
                  engine: cached.vehicle_engine
                },
                new Date().toISOString()
              );
              
              console.log(`[Tekmetric Webhook] Indexed ${jobsIndexed} jobs for RO #${roNumber}`);
              
              await sql`
                UPDATE tekmetric_work_orders SET jobs_indexed = true WHERE work_order_id = ${String(roId)}
              `;
            } catch (err: any) {
              console.error(`[Tekmetric Webhook] Job indexing failed for RO #${roNumber}:`, err.message);
            }
          }
        }
        
        await sql`
          UPDATE tekmetric_work_orders
          SET status = ${statusName || "Posted"}, status_code = ${statusCode || "POSTED"}, closed_at = NOW(), updated_at = NOW()
          WHERE work_order_id = ${String(roId)}
        `;
        
        console.log(`[Tekmetric Webhook] Updated cache entries for RO #${roNumber} to ${statusName || "Posted"}`);
      } else {
        const existingRows = await sql`
          SELECT * FROM tekmetric_work_orders WHERE work_order_id = ${String(roId)}
        `;
        const existingWO = existingRows[0] as any;
        
        if (existingWO) {
          const newLabel = repairOrder.repairOrderCustomLabel?.name || repairOrder.repairOrderLabel?.name || null;
          await sql`
            UPDATE tekmetric_work_orders
            SET status = ${statusName}, status_code = ${statusCode}, label = ${newLabel}, label_color = ${repairOrder.color || null}, updated_at = NOW()
            WHERE work_order_id = ${String(roId)}
          `;
          console.log(`[Tekmetric Webhook] Updated RO #${roNumber}: status=${statusName}, label=${newLabel}`);
        } else {
          const shopRows = await sql`
            SELECT * FROM shops WHERE tekmetric_shop_id = ${String(tekmetricShopId)}
          `;
          const shop = shopRows[0] as any;
          
          if (shop && repairOrder.vehicleId) {
            try {
              const vehicle = await getVehicle(repairOrder.vehicleId);
              
              if (vehicle?.vin) {
                let customerName = "Unknown Customer";
                try {
                  const customer = await getCustomer(repairOrder.customerId);
                  customerName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || "Unknown Customer";
                } catch (e) {}
                
                const mileage = repairOrder.milesIn || repairOrder.milesOut || vehicle.mileageIn || vehicle.mileageOut || null;
                
                await sql`
                  INSERT INTO tekmetric_work_orders (
                    work_order_id, work_order_number, shop_id, tekmetric_shop_id, vin,
                    vehicle_year, vehicle_make, vehicle_model, vehicle_engine,
                    customer_name, customer_id, odometer, status, status_code,
                    label, label_color, fetched_at, created_at, updated_at
                  ) VALUES (
                    ${String(roId)}, ${String(roNumber)}, ${shop.shop_id}, ${String(tekmetricShopId)}, ${vehicle.vin.toUpperCase()},
                    ${vehicle.year || null}, ${vehicle.make || null}, ${vehicle.model || null}, ${vehicle.engine || null},
                    ${customerName}, ${String(repairOrder.customerId)}, ${mileage}, ${statusName || "Estimate"}, ${statusCode || null},
                    ${repairOrder.repairOrderCustomLabel?.name || repairOrder.repairOrderLabel?.name || null}, ${repairOrder.color || null},
                    NOW(), NOW(), NOW()
                  )
                `;
                
                console.log(`[Tekmetric Webhook] Created new work order #${roNumber} for VIN ${vehicle.vin}`);
              } else {
                console.log(`[Tekmetric Webhook] Skipped RO #${roNumber} - vehicle has no VIN`);
              }
            } catch (err: any) {
              console.error(`[Tekmetric Webhook] Failed to fetch vehicle ${repairOrder.vehicleId}:`, err.message);
            }
          } else {
            console.log(`[Tekmetric Webhook] Skipped RO #${roNumber} - shop not found or no vehicleId`);
          }
        }
      }
    }
    
    if (isInspectionComplete) {
      const repairOrderId = data.repairOrderId || data.repair_order_id || data.roId;
      const inspectionData = data;
      
      if (repairOrderId) {
        await sql`
          UPDATE tekmetric_work_orders
          SET dvi_done = true, dvi_completed_at = NOW(), last_inspection = ${JSON.stringify(inspectionData)}::jsonb,
              inspections = COALESCE(inspections, '[]'::jsonb) || ${JSON.stringify([{...inspectionData, receivedAt: new Date()}])}::jsonb
          WHERE work_order_id = ${String(repairOrderId)}
        `;
        console.log(`[Tekmetric Webhook] Marked RO ${repairOrderId} as DVI complete.`);
      }
    }
    
    if (isCustomerViewed) {
      const repairOrderId = data.repairOrderId || data.repair_order_id || data.roId;
      
      if (repairOrderId) {
        await sql`
          UPDATE tekmetric_work_orders
          SET customer_viewed_dvi = true, customer_viewed_dvi_at = NOW()
          WHERE work_order_id = ${String(repairOrderId)}
        `;
        console.log(`[Tekmetric Webhook] Customer viewed DVI for RO ${repairOrderId}`);
      }
    }
    
    await sql`
      INSERT INTO tekmetric_webhook_logs (event_type, data, raw_body, received_at)
      VALUES (${eventType}, ${JSON.stringify(data)}::jsonb, ${JSON.stringify(body)}::jsonb, NOW())
    `;
    
    await sql`
      INSERT INTO dashboard_updates (id, timestamp) VALUES ('lastUpdate', ${Date.now()})
      ON CONFLICT (id) DO UPDATE SET timestamp = ${Date.now()}
    `;
    
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("[Tekmetric Webhook] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ 
    status: "Tekmetric webhook endpoint active",
    events: [
      "InspectionComplete",
      "CustomerViewedInspection",
      "RepairOrder.Posted",
      "RepairOrder.Invoiced",
      "RepairOrder.Updated"
    ],
    webhookUrl: process.env.REPLIT_DEV_DOMAIN 
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/webhooks/tekmetric`
      : "/api/webhooks/tekmetric"
  });
}
