import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { indexTekmetricWorkOrderJobs } from "@/lib/tekmetric-job-index";
import { getVehicle, getCustomer } from "@/lib/tekmetric";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL_STATUSES = ["invoice", "invoiced", "posted", "deleted", "void", "closed"];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const db = await getDb();
    
    console.log("[Tekmetric Webhook] Received event:", JSON.stringify(body, null, 2).slice(0, 1000));
    
    const eventType = body.event || body.eventType || body.type || "";
    const data = body.data || body.payload || body;
    
    // Handle both nested (data.repairOrder) and flat (data is the repair order) structures
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
        
        const cached = await db.collection("tekmetric_work_orders").findOne({
          workOrderId: String(roId)
        });
        
        if (cached && !cached.jobsIndexed && cached.vin) {
          const shop = await db.collection("shops").findOne({
            "tekmetric.shopId": tekmetricShopId
          });
          
          if (shop) {
            try {
              const jobsIndexed = await indexTekmetricWorkOrderJobs(
                Number(shop.shopId),
                tekmetricShopId,
                roId,
                roNumber,
                {
                  vin: cached.vin,
                  year: cached.vehicleYear,
                  make: cached.vehicleMake,
                  model: cached.vehicleModel,
                  engine: cached.vehicleEngine
                },
                new Date().toISOString()
              );
              
              console.log(`[Tekmetric Webhook] Indexed ${jobsIndexed} jobs for RO #${roNumber}`);
              
              await db.collection("tekmetric_work_orders").updateMany(
                { workOrderId: String(roId) },
                { $set: { jobsIndexed: true } }
              );
            } catch (err: any) {
              console.error(`[Tekmetric Webhook] Job indexing failed for RO #${roNumber}:`, err.message);
            }
          }
        }
        
        const result = await db.collection("tekmetric_work_orders").updateMany(
          { workOrderId: String(roId) },
          { 
            $set: { 
              status: statusName || "Posted",
              statusCode: statusCode || "POSTED",
              closedAt: new Date(),
              updatedAt: new Date()
            }
          }
        );
        
        console.log(`[Tekmetric Webhook] Updated ${result.modifiedCount} cache entries for RO #${roNumber} to ${statusName || "Posted"}`);
      } else {
        // Check if this work order already exists
        const existingWO = await db.collection("tekmetric_work_orders").findOne({
          workOrderId: String(roId)
        });
        
        if (existingWO) {
          // Update existing work order
          const newLabel = repairOrder.repairOrderCustomLabel?.name || repairOrder.repairOrderLabel?.name || null;
          const result = await db.collection("tekmetric_work_orders").updateOne(
            { workOrderId: String(roId) },
            { 
              $set: { 
                status: statusName,
                statusCode: statusCode,
                label: newLabel,
                labelColor: repairOrder.color || null,
                updatedAt: new Date()
              }
            }
          );
          console.log(`[Tekmetric Webhook] Updated RO #${roNumber}: status=${statusName}, label=${newLabel}, matched=${result.matchedCount}, modified=${result.modifiedCount}`);
        } else {
          // New work order - fetch vehicle and customer details, then create
          const shop = await db.collection("shops").findOne({
            "tekmetric.shopId": tekmetricShopId
          });
          
          if (shop && repairOrder.vehicleId) {
            try {
              const vehicle = await getVehicle(repairOrder.vehicleId);
              
              if (vehicle?.vin) {
                let customerName = "Unknown Customer";
                try {
                  const customer = await getCustomer(repairOrder.customerId);
                  customerName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || "Unknown Customer";
                } catch (e) {
                  // Customer fetch failed, use default
                }
                
                const mileage = repairOrder.milesIn || repairOrder.milesOut || vehicle.mileageIn || vehicle.mileageOut;
                
                await db.collection("tekmetric_work_orders").insertOne({
                  workOrderId: String(roId),
                  workOrderNumber: roNumber,
                  shopId: String(shop.shopId),
                  tekmetricShopId: tekmetricShopId,
                  vin: vehicle.vin.toUpperCase(),
                  vehicleYear: vehicle.year,
                  vehicleMake: vehicle.make,
                  vehicleModel: vehicle.model,
                  vehicleEngine: vehicle.engine,
                  customerName,
                  customerId: repairOrder.customerId,
                  odometer: mileage,
                  status: statusName || "Estimate",
                  statusCode: statusCode,
                  label: repairOrder.repairOrderCustomLabel?.name || repairOrder.repairOrderLabel?.name || null,
                  labelColor: repairOrder.color || null,
                  fetchedAt: new Date(),
                  createdAt: new Date(),
                  updatedAt: new Date(),
                });
                
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
        const result = await db.collection("tekmetric_work_orders").updateMany(
          { workOrderId: String(repairOrderId) },
          { 
            $set: { 
              dviDone: true,
              dviCompletedAt: new Date(),
              lastInspection: inspectionData
            },
            $push: { 
              inspections: {
                ...inspectionData,
                receivedAt: new Date()
              } 
            }
          }
        );
        console.log(`[Tekmetric Webhook] Marked RO ${repairOrderId} as DVI complete. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);
      }
    }
    
    if (isCustomerViewed) {
      const repairOrderId = data.repairOrderId || data.repair_order_id || data.roId;
      
      if (repairOrderId) {
        await db.collection("tekmetric_work_orders").updateOne(
          { workOrderId: String(repairOrderId) },
          { 
            $set: { 
              customerViewedDvi: true,
              customerViewedDviAt: new Date()
            }
          }
        );
        console.log(`[Tekmetric Webhook] Customer viewed DVI for RO ${repairOrderId}`);
      }
    }
    
    await db.collection("tekmetric_webhook_logs").insertOne({
      eventType,
      data,
      rawBody: body,
      receivedAt: new Date()
    });
    
    await db.collection("dashboard_updates").updateOne(
      { _id: "lastUpdate" },
      { $set: { timestamp: Date.now() } },
      { upsert: true }
    );
    
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
