import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  fetchVehicleById,
  fetchWorkOrderById,
  upsertProtractorVehicleSnapshot,
  upsertProtractorWorkOrderSnapshot,
} from "@/lib/integrations/protractor";
import { attributeRevenueFromWorkOrder } from "@/lib/enterprise";
import { Db, ObjectId } from "mongodb";

const VALID_TERMINAL_STATUSES = ["INVOICED", "INVOICE", "CLOSED", "VOID"];
const MAX_IMMEDIATE_RETRIES = 3;
const RETRY_DELAY_MS = 2000; // 2 seconds between retries

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function signalDashboardUpdate(db: Db) {
  try {
    await db.collection("dashboard_updates").updateOne(
      { _id: "lastUpdate" } as any,
      { $set: { timestamp: Date.now() } },
      { upsert: true }
    );
  } catch (e) {}
}

async function processCallbackEvent(
  db: Db,
  eventId: ObjectId,
  shopId: number,
  objectType: string,
  objectId: string,
  operation: string
): Promise<boolean> {
  try {
    if (objectType === "ServiceItem" && objectId) {
      const result = await fetchVehicleById(shopId, objectId);
      if (result.ok && result.vehicle?.VIN) {
        await upsertProtractorVehicleSnapshot(shopId, result.vehicle.VIN, result.vehicle);
        console.log(`[Protractor Callback] Processed vehicle ${result.vehicle.VIN}`);
        
        await db.collection("protractor_callback_events").updateOne(
          { _id: eventId },
          { $set: { processed: true, processedAt: new Date(), vin: result.vehicle.VIN } }
        );
        return true;
      }
    }

    if (objectType === "WorkOrder" && objectId && operation === "Delete") {
      const existingWO = await db.collection("protractor_work_orders").findOne({
        shopId: { $in: [String(shopId), Number(shopId)] },
        workOrderId: objectId
      });

      await db.collection("protractor_work_orders").updateMany(
        { shopId: { $in: [String(shopId), Number(shopId)] }, workOrderId: objectId },
        { $set: { completed: true, status: "Deleted", workflowStage: "Deleted", deletedAt: new Date(), deletedViaCallback: true } }
      );

      if (existingWO?.vin) {
        const otherActiveWOs = await db.collection("protractor_work_orders").countDocuments({
          shopId: { $in: [String(shopId), Number(shopId)] },
          vin: existingWO.vin,
          completed: { $ne: true },
          workOrderId: { $ne: objectId }
        });

        if (otherActiveWOs === 0) {
          await db.collection("vehicles").updateOne(
            {
              $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
              vin: existingWO.vin
            },
            {
              $set: {
                "status.active": false,
                "status.updatedAt": new Date(),
                updatedAt: new Date()
              }
            }
          );
        }

        const existingVehicle = await db.collection("vehicles").findOne({
          $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
          vin: existingWO.vin
        });
        if (existingVehicle) {
          const updatedSources = (existingVehicle.status?.sources || []).filter(
            (s: any) => !(s.provider === "protractor" && String(s.workOrderId) === String(objectId))
          );
          await db.collection("vehicles").updateOne(
            { _id: existingVehicle._id },
            { $set: { "status.sources": updatedSources, "status.updatedAt": new Date() } }
          );
        }
      }

      await signalDashboardUpdate(db);
      console.log(`[Protractor Callback] Deleted work order ${objectId} (WO#${existingWO?.workOrderNumber || '?'}) from dashboard`);

      await db.collection("protractor_callback_events").updateOne(
        { _id: eventId },
        { $set: { processed: true, processedAt: new Date(), workOrderNumber: existingWO?.workOrderNumber, deletedFromDashboard: true } }
      );
      return true;
    }

    if (objectType === "WorkOrder" && objectId) {
      const result = await fetchWorkOrderById(shopId, objectId);
      if (result.ok && result.workOrder) {
        await upsertProtractorWorkOrderSnapshot(shopId, result.workOrder);
        await signalDashboardUpdate(db);
        console.log(`[Protractor Callback] Processed work order ${objectId}`);

        // Upsert vehicle snapshot for immediate dashboard display
        const vin = result.workOrder.ServiceItem?.VIN?.toUpperCase();
        if (vin && result.workOrder.ServiceItem) {
          await upsertProtractorVehicleSnapshot(shopId, vin, result.workOrder.ServiceItem);

          // Update vehicles collection for active tracking
          const vehicle = result.workOrder.ServiceItem;
          const currentOdometer = result.workOrder.InUsage ?? (vehicle as any).Usage ?? result.workOrder.Odometer ?? (vehicle as any).Odometer;

          const workOrderSource = {
            provider: "protractor",
            workOrderId: String(result.workOrder.ID),
            workOrderNumber: result.workOrder.WorkOrderNumber,
            status: result.workOrder.WorkflowStage || "Open",
            addedAt: new Date(),
          };

          const existingVehicle = await db.collection("vehicles").findOne({
            $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
            vin,
          });

          if (existingVehicle) {
            const existingSources = existingVehicle.status?.sources || [];
            const sourceIndex = existingSources.findIndex(
              (s: any) => s.provider === "protractor" && String(s.workOrderId) === String(result.workOrder!.ID)
            );

            let updatedSources;
            if (sourceIndex >= 0) {
              updatedSources = [...existingSources];
              updatedSources[sourceIndex] = workOrderSource;
            } else {
              updatedSources = [...existingSources, workOrderSource];
            }

            await db.collection("vehicles").updateOne(
              { _id: existingVehicle._id },
              {
                $set: {
                  year: (vehicle as any).Year ?? existingVehicle.year,
                  make: (vehicle as any).Make ?? existingVehicle.make,
                  model: (vehicle as any).Model ?? existingVehicle.model,
                  lastMileage: currentOdometer ?? existingVehicle.lastMileage,
                  updatedAt: new Date(),
                  "status.active": !result.workOrder!.Completed,
                  "status.sources": updatedSources,
                  "status.updatedAt": new Date(),
                },
              }
            );
          } else if (!result.workOrder.Completed) {
            await db.collection("vehicles").insertOne({
              shopId: String(shopId),
              vin,
              year: (vehicle as any).Year,
              make: (vehicle as any).Make,
              model: (vehicle as any).Model,
              lastMileage: currentOdometer,
              protractorId: (vehicle as any).ID,
              status: {
                active: true,
                sources: [workOrderSource],
                updatedAt: new Date(),
              },
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
        }
        
        if (result.workOrder.Completed) {
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
                  console.log(`[Protractor Callback] Revenue attribution: ${attribution.matched} jobs`);
                }
              } catch (e) {
                // Revenue attribution is non-critical
              }
            }
          }
        }
        
        await db.collection("protractor_callback_events").updateOne(
          { _id: eventId },
          { $set: { processed: true, processedAt: new Date(), workOrderNumber: result.workOrder.WorkOrderNumber } }
        );
        return true;
      }
    }

    // No action needed for this event type
    await db.collection("protractor_callback_events").updateOne(
      { _id: eventId },
      { $set: { processed: true, processedAt: new Date(), noAction: true } }
    );
    return true;

  } catch (error: any) {
    console.error(`[Protractor Callback] Processing error:`, error.message);
    return false;
  }
}

async function processWithRetries(
  db: Db,
  eventId: ObjectId,
  shopId: number,
  objectType: string,
  objectId: string,
  operation: string,
  remainingAttempts: number = MAX_IMMEDIATE_RETRIES
): Promise<void> {
  for (let attempt = 1; attempt <= remainingAttempts; attempt++) {
    await sleep(RETRY_DELAY_MS);
    
    const success = await processCallbackEvent(db, eventId, shopId, objectType, objectId, operation);
    
    if (success) {
      console.log(`[Protractor Callback] Background retry succeeded on attempt ${attempt}`);
      return;
    }
    
    await db.collection("protractor_callback_events").updateOne(
      { _id: eventId },
      { 
        $set: { lastAttemptAt: new Date() },
        $inc: { attempts: 1 }
      }
    );
    
    if (attempt < remainingAttempts) {
      console.log(`[Protractor Callback] Retry ${attempt}/${remainingAttempts} failed, trying again...`);
    } else {
      console.log(`[Protractor Callback] All retries exhausted, leaving for daily cron`);
    }
  }
}
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

    // For NEW/OPEN work orders, immediately fetch from Protractor and upsert
    // so they appear on the dashboard right away (not just after daily cron)
    if (!isClosed && workOrderId) {
      const shopId = Number(shop.shopId);
      console.log(`[Protractor Callback] New/open work order ${workOrderId} with status: ${status} (shop: ${shopId}) - fetching immediately`);

      try {
        const result = await fetchWorkOrderById(shopId, workOrderId);
        if (result.ok && result.workOrder) {
          await upsertProtractorWorkOrderSnapshot(shopId, result.workOrder);
          await signalDashboardUpdate(db);
          console.log(`[Protractor Callback] Upserted work order ${workOrderId} for immediate dashboard display`);

          // Also upsert vehicle snapshot if VIN is available
          const vin = result.workOrder.ServiceItem?.VIN?.toUpperCase();
          if (vin && result.workOrder.ServiceItem) {
            await upsertProtractorVehicleSnapshot(shopId, vin, result.workOrder.ServiceItem);
            console.log(`[Protractor Callback] Upserted vehicle ${vin} for shop ${shopId}`);
          }

          // Also update the vehicles collection so it stays in sync
          if (vin) {
            const vehicle = result.workOrder.ServiceItem;
            const currentOdometer = result.workOrder.InUsage ?? vehicle?.Usage ?? result.workOrder.Odometer ?? vehicle?.Odometer;

            const workOrderSource = {
              provider: "protractor",
              workOrderId: String(result.workOrder.ID),
              workOrderNumber: result.workOrder.WorkOrderNumber,
              status: result.workOrder.WorkflowStage || status || "Open",
              addedAt: new Date(),
            };

            const existingVehicle = await db.collection("vehicles").findOne({
              $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
              vin,
            });

            if (existingVehicle) {
              const existingSources = existingVehicle.status?.sources || [];
              const sourceIndex = existingSources.findIndex(
                (s: any) => s.provider === "protractor" && String(s.workOrderId) === String(result.workOrder!.ID)
              );

              let updatedSources;
              if (sourceIndex >= 0) {
                updatedSources = [...existingSources];
                updatedSources[sourceIndex] = workOrderSource;
              } else {
                updatedSources = [...existingSources, workOrderSource];
              }

              await db.collection("vehicles").updateOne(
                { _id: existingVehicle._id },
                {
                  $set: {
                    year: vehicle?.Year ?? existingVehicle.year,
                    make: vehicle?.Make ?? existingVehicle.make,
                    model: vehicle?.Model ?? existingVehicle.model,
                    license: vehicle?.LicensePlate ?? existingVehicle.license,
                    lastMileage: currentOdometer ?? existingVehicle.lastMileage,
                    updatedAt: new Date(),
                    protractorId: vehicle?.ID ?? existingVehicle.protractorId,
                    "status.active": true,
                    "status.sources": updatedSources,
                    "status.updatedAt": new Date(),
                  },
                }
              );
            } else {
              await db.collection("vehicles").insertOne({
                shopId: String(shopId),
                vin,
                year: vehicle?.Year,
                make: vehicle?.Make,
                model: vehicle?.Model,
                license: vehicle?.LicensePlate,
                lastMileage: currentOdometer,
                protractorId: vehicle?.ID,
                status: {
                  active: true,
                  sources: [workOrderSource],
                  updatedAt: new Date(),
                },
                createdAt: new Date(),
                updatedAt: new Date(),
              });
            }
          }

          await db.collection("protractor_callback_events").updateOne(
            { workOrderId, processed: false },
            { $set: { processed: true, processedAt: new Date(), workOrderNumber: result.workOrder.WorkOrderNumber } }
          );
        } else {
          console.log(`[Protractor Callback] Failed to fetch work order ${workOrderId}: ${result.error}`);
        }
      } catch (fetchErr: any) {
        console.error(`[Protractor Callback] Error fetching new work order ${workOrderId}:`, fetchErr.message);
      }
    }

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

      await signalDashboardUpdate(db);
    }

    return NextResponse.json({ 
      received: true, 
      status: "acknowledged",
      workOrderId,
      workOrderStatus: status,
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

    // Deduplication: skip if we already processed this exact object+operation in the last 60 seconds
    // IMPORTANT: Include operation in the query so Delete is not skipped when Update was just processed
    if (objectId) {
      const recentDuplicate = await db.collection("protractor_callback_events").findOne({
        shopId,
        objectType,
        objectId,
        operation,
        processed: true,
        processedAt: { $gte: new Date(Date.now() - 60000) }
      });

      if (recentDuplicate) {
        console.log(`[Protractor Callback GET] Skipping duplicate ${operation} ${objectType} ${objectId} for shop ${shopId} (processed ${Math.round((Date.now() - recentDuplicate.processedAt.getTime()) / 1000)}s ago)`);
        return NextResponse.json({ 
          ok: true, 
          status: "duplicate_skipped",
          type: objectType,
          operation
        });
      }
    }

    // Log the event
    const insertResult = await db.collection("protractor_callback_events").insertOne({
      receivedAt: new Date(),
      method: "GET",
      connectionId,
      objectType,
      objectId,
      operation,
      shopId,
      processed: false,
      attempts: 0,
      priority: 1
    });

    const eventId = insertResult.insertedId;
    console.log(`[Protractor Callback GET] Logged ${objectType} ${objectId} for shop ${shopId}`);

    // Try to process immediately — if it works, return real success
    if (objectId) {
      const success = await processCallbackEvent(db, eventId, shopId, objectType, objectId, operation || "Unknown");
      
      if (success) {
        return NextResponse.json({ 
          ok: true, 
          status: "processed",
          type: objectType,
          operation
        });
      }

      // First attempt failed — queue remaining retries in background, respond as queued
      await db.collection("protractor_callback_events").updateOne(
        { _id: eventId },
        { $set: { lastAttemptAt: new Date() }, $inc: { attempts: 1 } }
      );

      processWithRetries(db, eventId, shopId, objectType, objectId, operation || "Unknown", 2)
        .catch(err => console.error(`[Protractor Callback] Background retry error:`, err.message));

      return NextResponse.json({ 
        received: true, 
        status: "queued",
        type: objectType,
        operation
      });
    }

    return NextResponse.json({ 
      received: true, 
      status: "acknowledged",
      type: objectType,
      operation
    });

  } catch (error: any) {
    console.error("[Protractor Callback GET] Error:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
