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
import * as callbackEvents from "@/lib/data/repositories/protractor-callback-events";
import type {
  AdmittedGetEvent,
  CallbackAdmissionIdentity,
  CallbackEventKey,
  GetEventIdentity,
} from "@/lib/data/repositories/protractor-callback-events";
import {
  fingerprintProtractorConnection,
  recordUnknownCallback,
} from "@/lib/data/repositories/protractor-callback-quarantine";

const VALID_TERMINAL_STATUSES = ["INVOICED", "INVOICE", "CLOSED", "VOID"];
const MAX_IMMEDIATE_RETRIES = 3;

function logCallbackOutcome(fields: {
  sourceRoute: string;
  method: "GET" | "POST";
  outcome: "admitted" | "coalesced" | "duplicate" | "rate_limited";
  shopId?: number;
  connectionId: string;
}): void {
  console.info(JSON.stringify({
    event: "protractor_callback_outcome",
    sourceRoute: fields.sourceRoute,
    method: fields.method,
    outcome: fields.outcome,
    ...(fields.shopId === undefined ? {} : { shopId: fields.shopId }),
    connectionFingerprint: fingerprintProtractorConnection(fields.connectionId),
  }));
}
const RETRY_DELAY_MS = 2000; // 2 seconds between retries

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function signalDashboardUpdate(
  db: Db,
  context?: { shopId?: number | string; workOrderId?: string },
) {
  try {
    await db.collection("dashboard_updates").updateOne(
      { _id: "lastUpdate" } as any,
      { $set: { timestamp: Date.now() } },
      { upsert: true }
    );
  } catch (e: any) {
    // Non-fatal for the callback's main path, but a swallowed failure
    // here leaves the dashboard stale with no signal — log at error
    // level (with shop/WO context) so it's visible to alerting.
    const ctx = [
      context?.shopId != null ? `shop ${context.shopId}` : null,
      context?.workOrderId ? `WO ${context.workOrderId}` : null,
    ].filter(Boolean).join(", ");
    console.error(
      `[Protractor Callback] Failed to signal dashboard update${ctx ? ` (${ctx})` : ""}: ${e?.message || e}`,
    );
  }
}

async function processCallbackEvent(
  db: Db,
  eventId: CallbackEventKey,
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
        
        await callbackEvents.markProcessed(eventId, { vin: result.vehicle.VIN });
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

      await signalDashboardUpdate(db, { shopId, workOrderId: objectId });
      console.log(`[Protractor Callback] Deleted work order ${objectId} (WO#${existingWO?.workOrderNumber || '?'}) from dashboard`);

      await callbackEvents.markProcessed(eventId, {
        workOrderNumber: existingWO?.workOrderNumber,
        deletedFromDashboard: true,
      });
      return true;
    }

    if (objectType === "WorkOrder" && objectId) {
      const result = await fetchWorkOrderById(shopId, objectId);
      if (result.ok && result.workOrder) {
        await upsertProtractorWorkOrderSnapshot(shopId, result.workOrder);
        await signalDashboardUpdate(db, { shopId, workOrderId: objectId });
        console.log(`[Protractor Callback] Processed work order ${objectId}`);

        const vin = (result.workOrder.ServiceItem?.VIN || result.workOrder.ServiceItem?.Lookup || '')?.toUpperCase() || null;
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
              } catch (e: any) {
                // Revenue attribution is non-critical to the callback's
                // success path, but a swallowed failure here silently
                // skews revenue/reporting — log at error level with
                // shop/WO context so the discrepancy is diagnosable.
                console.error(
                  `[Protractor Callback] Revenue attribution failed (shop ${shopId}, WO ${objectId}, vin ${vin}): ${e?.message || e}`,
                );
              }
            }
          }
        }
        
        await callbackEvents.markProcessed(eventId, {
          workOrderNumber: result.workOrder.WorkOrderNumber,
        });
        return true;
      }
    }

    // No action needed for this event type
    await callbackEvents.markProcessed(eventId, { noAction: true });
    return true;

  } catch (error: any) {
    console.error(`[Protractor Callback] Processing error:`, error.message);
    return false;
  }
}

// Background enrichment for new/open work orders — extracted out of the
// POST handler so we can ack the webhook in <50ms instead of blocking
// on a round-trip to Protractor's own API. Fire-and-forget from the
// caller; this function owns its own try/catch so a failure here can
// never leak into the webhook response.
//
// Safety note (2026-05-13): we run on Render in long-running Node
// process mode (not serverless / Edge), so the process is NOT torn
// down after Response is sent — fire-and-forget Promises continue to
// execute. If we ever move this route to a serverless / Edge runtime
// we MUST switch to `unstable_after()` from `next/server` (or push
// the work to an external queue) so the background task isn't killed
// mid-flight.
//
// `eventId` is the _id of the row we just inserted into
// protractor_callback_events, scoped per request. Passing it lets us
// stamp processed/lastAttemptAt on the SPECIFIC event row instead of
// matching by `{workOrderId, processed:false}` — which would race if
// two webhooks for the same workOrderId arrive nearly simultaneously
// and clobber each other's status.
async function enrichOpenWorkOrderInBackground(
  db: Db,
  shopId: number,
  workOrderId: string,
  status: string | null,
  eventId: CallbackEventKey,
): Promise<void> {
  try {
    const result = await fetchWorkOrderById(shopId, workOrderId);
    if (!result.ok || !result.workOrder) {
      const errMsg = result.ok ? "no workOrder in result" : result.error;
      console.log(`[Protractor Callback] Background enrich: failed to fetch WO ${workOrderId}: ${errMsg}`);
      // Stamp lastAttemptAt + increment attempts so the daily cron
      // sees this as a retry candidate rather than thinking it was
      // never attempted. We deliberately leave processed: false.
      await callbackEvents.recordAttempt(eventId, String(errMsg));
      return;
    }

    await upsertProtractorWorkOrderSnapshot(shopId, result.workOrder);
    await signalDashboardUpdate(db, { shopId, workOrderId });
    console.log(`[Protractor Callback] Background enrich: upserted WO ${workOrderId} (shop ${shopId})`);

    const vin = (result.workOrder.ServiceItem?.VIN || result.workOrder.ServiceItem?.Lookup || '')?.toUpperCase() || null;
    if (vin && result.workOrder.ServiceItem) {
      await upsertProtractorVehicleSnapshot(shopId, vin, result.workOrder.ServiceItem);

      const vehicle = result.workOrder.ServiceItem;
      const currentOdometer = result.workOrder.InUsage ?? (vehicle as any)?.Usage ?? result.workOrder.Odometer ?? (vehicle as any)?.Odometer;

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
              year: (vehicle as any)?.Year ?? existingVehicle.year,
              make: (vehicle as any)?.Make ?? existingVehicle.make,
              model: (vehicle as any)?.Model ?? existingVehicle.model,
              license: (vehicle as any)?.LicensePlate ?? existingVehicle.license,
              lastMileage: currentOdometer ?? existingVehicle.lastMileage,
              updatedAt: new Date(),
              protractorId: (vehicle as any)?.ID ?? existingVehicle.protractorId,
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
          year: (vehicle as any)?.Year,
          make: (vehicle as any)?.Make,
          model: (vehicle as any)?.Model,
          license: (vehicle as any)?.LicensePlate,
          lastMileage: currentOdometer,
          protractorId: (vehicle as any)?.ID,
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

    await callbackEvents.markProcessed(eventId, {
      workOrderNumber: result.workOrder.WorkOrderNumber,
    });
  } catch (err: any) {
    console.error(`[Protractor Callback] Background enrich error for WO ${workOrderId}:`, err?.message || err);
    // Stamp lastAttemptAt + increment attempts so the daily cron picks
    // it up on the next pass; deliberately leave processed: false.
    try {
      await callbackEvents.recordAttempt(eventId, String(err?.message || err));
    } catch {}
  }
}

async function processAdmittedOpenPost(
  db: Db,
  shopId: number,
  workOrderId: string,
  status: string | null,
  eventId: CallbackEventKey,
  identity: CallbackAdmissionIdentity,
  claimFollowUp: boolean,
): Promise<void> {
  try {
    await enrichOpenWorkOrderInBackground(
      db,
      shopId,
      workOrderId,
      status,
      eventId,
    );
  } finally {
    const followUp = await callbackEvents.finishCallbackEventAdmission(
      eventId,
      identity,
      claimFollowUp,
    );
    if (followUp) {
      processAdmittedOpenPost(
        db,
        shopId,
        workOrderId,
        status,
        followUp.key,
        followUp,
        false,
      ).catch((err: any) =>
        console.error(
          "[Protractor Callback] POST coalesced follow-up error:",
          err?.message || err,
        ),
      );
    }
  }
}

async function processWithRetries(
  db: Db,
  eventId: CallbackEventKey,
  shopId: number,
  objectType: string,
  objectId: string,
  operation: string,
  remainingAttempts: number = MAX_IMMEDIATE_RETRIES
): Promise<boolean> {
  for (let attempt = 1; attempt <= remainingAttempts; attempt++) {
    await sleep(RETRY_DELAY_MS);
    
    const success = await processCallbackEvent(db, eventId, shopId, objectType, objectId, operation);
    
    if (success) {
      console.log(`[Protractor Callback] Background retry succeeded on attempt ${attempt}`);
      return true;
    }
    
    await callbackEvents.recordAttempt(eventId);
    
    if (attempt < remainingAttempts) {
      console.log(`[Protractor Callback] Retry ${attempt}/${remainingAttempts} failed, trying again...`);
    } else {
      console.log(`[Protractor Callback] All retries exhausted, leaving for daily cron`);
    }
  }
  return false;
}

async function processAdmittedFollowUp(
  db: Db,
  event: AdmittedGetEvent,
): Promise<void> {
  try {
    const success = await processCallbackEvent(
      db,
      event.key,
      event.shopId,
      event.objectType,
      event.objectId,
      event.operation || "Unknown",
    );
    if (!success) {
      await callbackEvents.recordAttempt(event.key);
      await processWithRetries(
        db,
        event.key,
        event.shopId,
        event.objectType,
        event.objectId,
        event.operation || "Unknown",
        2,
      );
    }
  } finally {
    // A promoted callback is the one bounded follow-up for this burst.
    // Events that arrived during its latest-state fetch are coalesced on
    // release rather than extending the worker indefinitely.
    await callbackEvents.finishGetEventAdmission(event.key, event, false);
  }
}

function launchFollowUp(db: Db, event: AdmittedGetEvent | null): void {
  if (!event) return;
  processAdmittedFollowUp(db, event).catch((err: any) =>
    console.error(
      `[Protractor Callback] Coalesced follow-up error:`,
      err?.message || err,
    ),
  );
}

async function continueAdmittedInitialWorker(
  db: Db,
  eventId: CallbackEventKey,
  identity: GetEventIdentity,
): Promise<void> {
  try {
    await processWithRetries(
      db,
      eventId,
      identity.shopId,
      identity.objectType,
      identity.objectId,
      identity.operation || "Unknown",
      2,
    );
  } finally {
    const followUp = await callbackEvents.finishGetEventAdmission(
      eventId,
      identity,
      true,
    );
    launchFollowUp(db, followUp);
  }
}
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 30;

async function checkRateLimit(connectionId: string): Promise<{ allowed: boolean; remaining: number }> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
  
  const recentCount = await callbackEvents.countRecentByConnection(connectionId, windowStart);
  
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
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { rawText: text };
      }
    } else {
      // Try to read as text and parse
      const text = await request.text();
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
    const sourceRoute = url.pathname;
    url.searchParams.forEach((value, key) => {
      if (!payload[key]) {
        payload[key] = value;
      }
    });
    
    const db = await getDb();

    const workOrderId = payload.WorkOrderGuid || payload.workOrderGuid || payload.ID || payload.id;
    const status = payload.Status || payload.status || payload.WorkflowStage || payload.workflowStage;
    const connectionId = payload.ConnectionId || payload.connectionId;

    if (!connectionId) {
      console.log("[Protractor Callback] Rejected: No connectionId in payload");
      return NextResponse.json({ ok: false, error: "Missing connectionId" }, { status: 400 });
    }

    const rateCheck = await checkRateLimit(connectionId);
    if (!rateCheck.allowed) {
      logCallbackOutcome({
        sourceRoute,
        method: "POST",
        outcome: "rate_limited",
        connectionId,
      });
      return NextResponse.json({ ok: false, error: "Rate limit exceeded" }, { status: 429 });
    }

    const shop = await db.collection("shops").findOne({
      $or: [
        { "protractor.connectionId": connectionId },
        { protractorConnectionId: connectionId }
      ]
    });

    if (!shop) {
      // Return 200 (not 403) for unknown connectionIds. Protractor's delivery
      // worker very likely uses a per-endpoint-URL circuit breaker — a flood of
      // 4xx from one stale/pre-provisioned connectionId can mute deliveries for
      // ALL our shops sharing this URL. We log + drop instead. See 2026-05-14
      // incident: 509 403s in 20min for a not-yet-provisioned Total True
      // Automotive connectionId, then 6+ days of system-wide silence.
      await recordUnknownCallback({
        method: "POST",
        sourceRoute,
        connectionId,
      }).catch((error: any) =>
        console.error(JSON.stringify({
          event: "protractor_unknown_callback_quarantine_error",
          sourceRoute,
          method: "POST",
          error: String(error?.message || error).slice(0, 200),
        })),
      );
      return NextResponse.json({ ok: true, ignored: true, reason: "Unknown connectionId" });
    }

    if (!workOrderId) {
      console.log("[Protractor Callback] No work order ID in payload");
      return NextResponse.json({ ok: true, message: "No work order ID" });
    }

    const normalizedStatus = String(status || "").trim().toUpperCase();
    const isClosed = VALID_TERMINAL_STATUSES.includes(normalizedStatus);

    const eventId = await callbackEvents.insertPostEvent({
      payload,
      workOrderId,
      status: status ?? null,
      connectionId,
      shopId: shop.shopId,
    });
    const postIdentity: CallbackAdmissionIdentity = {
      shopId: Number(shop.shopId),
      method: "POST",
      objectType: "WorkOrder",
      objectId: String(workOrderId),
      operation: normalizedStatus,
    };
    const postAdmitted = await callbackEvents.admitCallbackEvent(
      eventId,
      postIdentity,
    );
    logCallbackOutcome({
      sourceRoute,
      method: "POST",
      outcome: postAdmitted ? "admitted" : "coalesced",
      shopId: Number(shop.shopId),
      connectionId,
    });

    // For NEW/OPEN work orders, fire enrichment in the background and ack
    // the webhook immediately. Doing the Protractor API round-trip inline
    // used to make our 200 wait on Protractor's own /workorders/{id}
    // response — which is the exact thing they asked us to stop doing on
    // 2026-05-13 ("webhooks to hit their site are taking a long time to
    // complete"). The enrichment helper owns its own try/catch so a
    // failure can never leak into the ack path.
    if (!isClosed && workOrderId) {
      const shopId = Number(shop.shopId);
      console.log(`[Protractor Callback] New/open work order ${workOrderId} with status: ${status} (shop: ${shopId}) - enriching in background`);
      if (postAdmitted) {
        // Fire-and-forget — DO NOT await.
        processAdmittedOpenPost(
          db,
          shopId,
          String(workOrderId),
          status ?? null,
          eventId,
          postIdentity,
          true,
        ).catch((err: any) =>
          console.error(
            "[Protractor Callback] Background enrich top-level error:",
            err?.message || err,
          ),
        );
      }
    }

    // (Legacy synchronous enrichment block removed 2026-05-13 —
    // enrichOpenWorkOrderInBackground above is now the single source
    // of truth so the webhook can ack in <50ms.)
    if (isClosed) {
      if (!postAdmitted) {
        return NextResponse.json({ ok: true, duplicate: true, coalesced: true });
      }
      try {
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

      await callbackEvents.markOneProcessedByWorkOrderStatus(workOrderId, status ?? null);

      await signalDashboardUpdate(db, { workOrderId });
      } finally {
        await callbackEvents.finishCallbackEventAdmission(
          eventId,
          postIdentity,
          false,
        );
      }
    }

    return NextResponse.json({ 
      received: true, 
      status: "acknowledged",
      callbackOutcome: postAdmitted ? "admitted" : "coalesced",
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
    const sourceRoute = url.pathname;
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
      // Return 200 (not 403) — see POST handler for full rationale.
      // 4xx flood from a stale/pre-provisioned connectionId can trip
      // Protractor's per-URL circuit breaker and mute all shops.
      await recordUnknownCallback({
        method: "GET",
        sourceRoute,
        connectionId,
      }).catch((error: any) =>
        console.error(JSON.stringify({
          event: "protractor_unknown_callback_quarantine_error",
          sourceRoute,
          method: "GET",
          error: String(error?.message || error).slice(0, 200),
        })),
      );
      return NextResponse.json({ ok: true, ignored: true, reason: "Unknown connectionId" });
    }

    const shopId = Number(shop.shopId);
    console.log(`[Protractor Callback GET] ${operation} ${objectType} ${objectId} for shop ${shopId}`);

    // Deduplication: skip if we already processed this exact object+operation in the last 60 seconds
    // IMPORTANT: Include operation in the query so Delete is not skipped when Update was just processed
    if (objectId) {
      const recentDuplicate = await callbackEvents.findRecentProcessedGet(
        shopId,
        objectType,
        objectId,
        operation ?? null,
        new Date(Date.now() - 60000),
      );

      if (recentDuplicate) {
        logCallbackOutcome({
          sourceRoute,
          method: "GET",
          outcome: "duplicate",
          shopId,
          connectionId,
        });
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
    const eventId = await callbackEvents.insertGetEvent({
      connectionId,
      objectType,
      objectId,
      operation: operation ?? null,
      shopId,
    });
    console.log(`[Protractor Callback GET] Logged ${objectType} ${objectId} for shop ${shopId}`);

    // Try to process immediately — if it works, return real success
    if (objectId) {
      const identity: GetEventIdentity = {
        shopId,
        objectType,
        objectId,
        operation: operation ?? null,
      };
      const admitted = await callbackEvents.admitGetEvent(eventId, identity);
      logCallbackOutcome({
        sourceRoute,
        method: "GET",
        outcome: admitted ? "admitted" : "coalesced",
        shopId,
        connectionId,
      });
      if (!admitted) {
        return NextResponse.json({
          ok: true,
          status: "coalesced",
          type: objectType,
          operation,
        });
      }

      const success = await processCallbackEvent(db, eventId, shopId, objectType, objectId, operation || "Unknown");
      
      if (success) {
        const followUp = await callbackEvents.finishGetEventAdmission(
          eventId,
          identity,
          true,
        );
        launchFollowUp(db, followUp);
        return NextResponse.json({ 
          ok: true, 
          status: "processed",
          type: objectType,
          operation
        });
      }

      // First attempt failed — queue remaining retries in background, respond as queued
      await callbackEvents.recordAttempt(eventId);

      continueAdmittedInitialWorker(db, eventId, identity)
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
