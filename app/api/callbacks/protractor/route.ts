import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

import { Db } from "mongodb";

const VALID_TERMINAL_STATUSES = ["INVOICED", "INVOICE", "CLOSED", "VOID"];
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 30;

async function checkRateLimit(db: Db, connectionId: string): Promise<{ allowed: boolean; remaining: number }> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
  
  const recentCount = await db.collection("protractor_callback_events").countDocuments({
    connectionId,
    receivedAt: { $gte: windowStart }
  });
  
  if (recentCount >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }
  
  return { allowed: true, remaining: RATE_LIMIT_MAX - recentCount };
}

export async function POST(request: NextRequest) {
  console.log("[Protractor Callback] POST received");
  console.log("[Protractor Callback] Headers:", Object.fromEntries(request.headers.entries()));
  
  try {
    const rawBody = await request.text();
    console.log("[Protractor Callback] Raw body:", rawBody.slice(0, 1000));
    
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch (parseErr) {
      console.log("[Protractor Callback] Body is not JSON, treating as form data");
      payload = Object.fromEntries(new URLSearchParams(rawBody));
    }
    
    console.log("[Protractor Callback] Parsed payload:", JSON.stringify(payload).slice(0, 500));

    const db = await getDb();

    const workOrderId = payload.WorkOrderGuid || payload.workOrderGuid || payload.ID || payload.id;
    const status = payload.Status || payload.status || payload.WorkflowStage || payload.workflowStage;
    const connectionId = payload.ConnectionId || payload.connectionId;

    if (!connectionId) {
      console.log("[Protractor Callback] Rejected: No connectionId in payload");
      return NextResponse.json({ ok: false, error: "Missing connectionId" }, { status: 400 });
    }

    const rateCheck = await checkRateLimit(db, connectionId);
    if (!rateCheck.allowed) {
      console.warn(`[Protractor Callback] Rate limited: connectionId ${connectionId}`);
      return NextResponse.json({ ok: false, error: "Rate limit exceeded" }, { status: 429 });
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

    const existingEvent = await db.collection("protractor_callback_events").findOne({
      workOrderId,
      status,
      processed: true,
      processedAt: { $gte: new Date(Date.now() - 300000) }
    });

    if (existingEvent) {
      console.log(`[Protractor Callback] Duplicate event for ${workOrderId}, skipping`);
      return NextResponse.json({ ok: true, duplicate: true });
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
    const isClosed = VALID_TERMINAL_STATUSES.includes(normalizedStatus);

    if (isClosed) {
      console.log(`[Protractor Callback] Work order ${workOrderId} closed with status: ${status} (shop: ${shop.shopId})`);

      const existingWorkOrder = await db.collection("protractor_work_orders").findOne({
        $or: [{ shopId: String(shop.shopId) }, { shopId: Number(shop.shopId) }],
        workOrderGuid: workOrderId
      });

      if (!existingWorkOrder) {
        console.log(`[Protractor Callback] Work order ${workOrderId} not found in our records, skipping`);
        return NextResponse.json({ ok: true, skipped: true, reason: "Unknown work order" });
      }

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
      }

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

      await db.collection("protractor_callback_events").updateOne(
        { workOrderId, status, processed: false },
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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  
  const connectionId = searchParams.get("connectionId");
  const apiKey = searchParams.get("apiKey");
  const type = searchParams.get("type");
  const id = searchParams.get("id");
  const operation = searchParams.get("operation");

  // If no params, return status info
  if (!connectionId && !type && !id) {
    return NextResponse.json({ 
      status: "ok", 
      endpoint: "Protractor Callback Receiver",
      methods: ["GET", "POST"],
      usage: "Supports both POST with JSON body and GET with query params"
    });
  }

  console.log(`[Protractor Callback] GET received: type=${type}, id=${id}, operation=${operation}, connectionId=${connectionId?.slice(0,8)}...`);

  try {
    const db = await getDb();

    if (!connectionId) {
      console.log("[Protractor Callback] Rejected: No connectionId in query params");
      return NextResponse.json({ ok: false, error: "Missing connectionId" }, { status: 400 });
    }

    const rateCheck = await checkRateLimit(db, connectionId);
    if (!rateCheck.allowed) {
      console.warn(`[Protractor Callback] Rate limited: connectionId ${connectionId}`);
      return NextResponse.json({ ok: false, error: "Rate limit exceeded" }, { status: 429 });
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

    // Log the callback event
    await db.collection("protractor_callback_events").insertOne({
      receivedAt: new Date(),
      method: "GET",
      connectionId,
      apiKey,
      type,
      objectId: id,
      operation,
      shopId: shop.shopId,
      processed: false
    });

    // Handle different object types
    if (type === "WorkOrder" && id) {
      const normalizedOperation = (operation || "").toUpperCase();
      const isClosed = normalizedOperation === "INVOICED" || normalizedOperation === "DELETE";

      if (isClosed) {
        console.log(`[Protractor Callback] Work order ${id} ${operation} (shop: ${shop.shopId})`);

        // Update work order status
        await db.collection("protractor_work_orders").updateMany(
          { workOrderGuid: id },
          {
            $set: {
              workflowStage: operation,
              status: operation,
              closedAt: new Date(),
              closedViaCallback: true,
              updatedAt: new Date()
            }
          }
        );

        // Update vehicle status if work order is closed
        const vehicle = await db.collection("vehicles").findOne({
          $or: [{ shopId: String(shop.shopId) }, { shopId: Number(shop.shopId) }],
          "status.active": true,
          "status.sources": {
            $elemMatch: {
              provider: "protractor",
              workOrderId: id
            }
          }
        });

        if (vehicle) {
          const existingSources = vehicle.status?.sources || [];
          const updatedSources = existingSources.filter(
            (s: any) => !(s.provider === "protractor" && String(s.workOrderId) === String(id))
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
        }
      } else if (normalizedOperation === "UPDATE") {
        // Work order created or updated - trigger a fetch to get latest data
        console.log(`[Protractor Callback] Work order ${id} updated, will be fetched on next sync (shop: ${shop.shopId})`);
        
        // Mark for priority fetch on next sync
        await db.collection("protractor_callback_events").updateOne(
          { objectId: id, type: "WorkOrder", processed: false },
          { $set: { needsFetch: true } }
        );
      }
    } else if (type === "ServiceItem" && id) {
      // ServiceItem = Vehicle in Protractor
      console.log(`[Protractor Callback] Vehicle/ServiceItem ${id} ${operation} (shop: ${shop.shopId})`);
      
      // Mark for priority fetch
      await db.collection("protractor_callback_events").updateOne(
        { objectId: id, type: "ServiceItem", processed: false },
        { $set: { needsFetch: true, isVehicle: true } }
      );
    } else if (type === "Contact" && id) {
      console.log(`[Protractor Callback] Contact ${id} ${operation} (shop: ${shop.shopId})`);
    }

    // Mark as processed
    await db.collection("protractor_callback_events").updateOne(
      { objectId: id, type, processed: false },
      { $set: { processed: true, processedAt: new Date() } }
    );

    return NextResponse.json({ 
      ok: true, 
      type,
      id,
      operation,
      shopId: shop.shopId
    });

  } catch (error: any) {
    console.error("[Protractor Callback] GET Error:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
