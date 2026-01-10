import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    
    console.log("[Protractor Callback] Received:", JSON.stringify(payload).slice(0, 500));

    const db = await getDb();

    const workOrderId = payload.WorkOrderGuid || payload.workOrderGuid || payload.ID || payload.id;
    const status = payload.Status || payload.status || payload.WorkflowStage || payload.workflowStage;
    const connectionId = payload.ConnectionId || payload.connectionId;

    if (!connectionId) {
      console.log("[Protractor Callback] Rejected: No connectionId in payload");
      return NextResponse.json({ ok: false, error: "Missing connectionId" }, { status: 400 });
    }

    const shop = await db.collection("shops").findOne({
      $or: [
        { "protractor.connectionId": connectionId },
        { protractorConnectionId: connectionId }
      ]
    });

    if (!shop) {
      console.log(`[Protractor Callback] Rejected: Unknown connectionId ${connectionId}`);
      return NextResponse.json({ ok: false, error: "Unknown connectionId" }, { status: 403 });
    }

    if (!workOrderId) {
      console.log("[Protractor Callback] No work order ID in payload");
      return NextResponse.json({ ok: true, message: "No work order ID" });
    }

    await db.collection("protractor_callback_events").insertOne({
      receivedAt: new Date(),
      payload,
      workOrderId,
      status,
      connectionId,
      shopId: shop.shopId,
      processed: false
    });

    const normalizedStatus = (status || "").toUpperCase();
    const isClosed = normalizedStatus === "INVOICED" || normalizedStatus === "INVOICE" || 
                     normalizedStatus === "CLOSED" || normalizedStatus === "VOID";

    if (isClosed) {
      console.log(`[Protractor Callback] Work order ${workOrderId} closed with status: ${status} (shop: ${shop.shopId})`);

      const vehicle = await db.collection("vehicles").findOne({
        $or: [{ shopId: String(shop.shopId) }, { shopId: Number(shop.shopId) }],
        "status.active": true,
        "status.sources": {
          $elemMatch: {
            provider: "protractor",
            workOrderId: workOrderId
          }
        }
      });

      if (vehicle) {
        const existingSources = vehicle.status?.sources || [];
        const updatedSources = existingSources.filter(
          (s: any) => !(s.provider === "protractor" && String(s.workOrderId) === String(workOrderId))
        );
        const hasActiveSources = updatedSources.length > 0;

        await db.collection("vehicles").updateOne(
          { _id: vehicle._id },
          {
            $set: {
              "status.active": hasActiveSources,
              "status.sources": updatedSources,
              ...(hasActiveSources ? {} : { "status.lastClosedAt": new Date() }),
              updatedAt: new Date()
            }
          }
        );

        console.log(`[Protractor Callback] Vehicle ${vehicle.vin} updated - active: ${hasActiveSources}`);

        await db.collection("protractor_work_orders").updateMany(
          { workOrderGuid: workOrderId },
          {
            $set: {
              workflowStage: status,
              status: status,
              closedAt: new Date(),
              closedViaCallback: true,
              updatedAt: new Date()
            }
          }
        );
      }

      await db.collection("protractor_callback_events").updateOne(
        { workOrderId, receivedAt: { $gte: new Date(Date.now() - 5000) } },
        { $set: { processed: true, processedAt: new Date() } }
      );
    }

    return NextResponse.json({ 
      ok: true, 
      workOrderId,
      status,
      isClosed 
    });

  } catch (error: any) {
    console.error("[Protractor Callback] Error:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ 
    status: "ok", 
    endpoint: "Protractor Callback Receiver",
    usage: "POST work order updates to this endpoint"
  });
}
