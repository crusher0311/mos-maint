import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  fetchVehicleById,
  fetchWorkOrderById,
  upsertProtractorVehicleSnapshot,
  upsertProtractorWorkOrderSnapshot,
} from "@/lib/integrations/protractor";
import { attributeRevenueFromWorkOrder } from "@/lib/enterprise";

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
  try {
    const contentType = request.headers.get("content-type") || "";
    console.log("[Protractor Callback] Content-Type:", contentType);
    
    let payload: any = {};
    
    // Handle different content types
    if (contentType.includes("application/json")) {
      payload = await request.json();
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      formData.forEach((value, key) => {
        payload[key] = value;
      });
    } else if (contentType.includes("text/")) {
      const text = await request.text();
      console.log("[Protractor Callback] Raw text:", text.slice(0, 500));
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { rawText: text };
      }
    } else {
      // Try to read as text and parse
      const text = await request.text();
      console.log("[Protractor Callback] Raw body:", text.slice(0, 500));
      try {
        payload = JSON.parse(text);
      } catch {
        // Try URL params
        const params = new URLSearchParams(text);
        params.forEach((value, key) => {
          payload[key] = value;
        });
      }
    }
    
    // Also capture query params
    const url = new URL(request.url);
    url.searchParams.forEach((value, key) => {
      if (!payload[key]) {
        payload[key] = value;
      }
    });
    
    console.log("[Protractor Callback] Received:", JSON.stringify(payload).slice(0, 500));

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
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId");
    const objectType = url.searchParams.get("type");
    const objectId = url.searchParams.get("id");
    const operation = url.searchParams.get("operation");

    if (!connectionId || !objectType || !objectId) {
      return NextResponse.json({ 
        status: "ok", 
        endpoint: "Protractor Callback Receiver",
        usage: "Include connectionId, type, id, and operation query params"
      });
    }

    const db = await getDb();

    const shop = await db.collection("shops").findOne({
      $or: [
        { "protractor.connectionId": connectionId },
        { protractorConnectionId: connectionId }
      ]
    });

    if (!shop) {
      console.log(`[Protractor Callback GET] Unknown connectionId: ${connectionId}`);
      return NextResponse.json({ ok: false, error: "Unknown connectionId" }, { status: 403 });
    }

    const shopId = Number(shop.shopId);
    console.log(`[Protractor Callback GET] ${operation} ${objectType} ${objectId} for shop ${shopId}`);

    await db.collection("protractor_callback_events").insertOne({
      receivedAt: new Date(),
      method: "GET",
      connectionId,
      objectType,
      objectId,
      operation,
      shopId,
      processed: false
    });

    if (objectType === "ServiceItem" && objectId && (operation === "Update" || operation === "Create")) {
      const result = await fetchVehicleById(shopId, objectId);
      if (result.ok && result.vehicle?.VIN) {
        await upsertProtractorVehicleSnapshot(shopId, result.vehicle.VIN, result.vehicle);
        console.log(`[Protractor Callback GET] ${operation} vehicle snapshot for ${result.vehicle.VIN}`);
        
        await db.collection("protractor_callback_events").updateOne(
          { objectId, objectType, processed: false },
          { $set: { processed: true, processedAt: new Date(), vin: result.vehicle.VIN } }
        );
        
        return NextResponse.json({ 
          ok: true, 
          type: objectType,
          operation,
          vin: result.vehicle.VIN,
          processed: true
        });
      }
    }

    if (objectType === "WorkOrder" && objectId) {
      const result = await fetchWorkOrderById(shopId, objectId);
      if (result.ok && result.workOrder) {
        await upsertProtractorWorkOrderSnapshot(shopId, result.workOrder);
        console.log(`[Protractor Callback GET] ${operation} work order snapshot ${objectId}`);
        
        if (result.workOrder.Completed) {
          const vin = result.workOrder.ServiceItem?.VIN?.toUpperCase();
          if (vin) {
            const savedWO = await db.collection("protractor_work_orders").findOne({
              shopId,
              workOrderId: objectId
            });
            
            if (savedWO && savedWO.packageSummaries?.length > 0) {
              try {
                const attribution = await attributeRevenueFromWorkOrder(
                  shopId,
                  objectId,
                  vin,
                  savedWO.packageSummaries,
                  "protractor"
                );
                if (attribution.matched > 0) {
                  console.log(`[Protractor Callback GET] Revenue attribution: ${attribution.matched} jobs, $${attribution.revenue.toFixed(2)}`);
                }
              } catch (e) {
                console.error("[Protractor Callback GET] Revenue attribution error:", e);
              }
            }
          }
        }
        
        await db.collection("protractor_callback_events").updateOne(
          { objectId, objectType, processed: false },
          { $set: { processed: true, processedAt: new Date(), workOrderNumber: result.workOrder.WorkOrderNumber } }
        );
        
        return NextResponse.json({ 
          ok: true, 
          type: objectType,
          operation,
          workOrderNumber: result.workOrder.WorkOrderNumber,
          processed: true
        });
      }
    }

    return NextResponse.json({ 
      ok: true, 
      type: objectType,
      operation,
      message: "No action taken"
    });

  } catch (error: any) {
    console.error("[Protractor Callback GET] Error:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
