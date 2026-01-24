import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { indexTekmetricWorkOrderJobs } from "@/lib/tekmetric-job-index";

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
    const repairOrder = data.repairOrder || body.repairOrder;
    
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
    
    if (isRepairOrderUpdate && repairOrder) {
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
        const result = await db.collection("tekmetric_work_orders").updateMany(
          { workOrderId: String(roId) },
          { 
            $set: { 
              status: statusName,
              statusCode: statusCode,
              updatedAt: new Date()
            }
          }
        );
        
        if (result.modifiedCount > 0) {
          console.log(`[Tekmetric Webhook] Updated RO #${roNumber} status to ${statusName}`);
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
