import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const db = await getDb();
    
    console.log("[Tekmetric Webhook] Received event:", JSON.stringify(body, null, 2));
    
    const eventType = body.event || body.eventType || body.type || "";
    const data = body.data || body.payload || body;
    
    const isInspectionComplete = 
      eventType.toLowerCase().includes("inspection") && 
      (eventType.toLowerCase().includes("complete") || eventType.toLowerCase().includes("marked complete"));
    
    const isCustomerViewed = 
      eventType.toLowerCase().includes("customer") && 
      eventType.toLowerCase().includes("viewed");
    
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
    events: ["InspectionComplete", "CustomerViewedInspection"]
  });
}
