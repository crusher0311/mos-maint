import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { indexTekmetricWorkOrderJobs } from "@/lib/tekmetric-job-index";
import { getVehicle, getCustomer } from "@/lib/tekmetric";
import { invalidateCachedPlan } from "@/lib/plan-cache";
import { triggerVhiOnWorkOrderClose, triggerVhiOnWorkOrderCreate, extractAuthorizedJobsFromTekmetricRo } from "@/lib/vhi-webhook-trigger";
import { NormalizedIngestionService } from "@/lib/normalized-ingestion";
import { getRepairOrderInspectionsWithXAuth } from "@/lib/integrations/tekmetric/client";
import type { Db } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL_STATUSES = ["invoice", "invoiced", "posted", "deleted", "void", "closed"];

/**
 * Phase B of the trust-the-webhooks migration: pipe webhook payloads through
 * `NormalizedIngestionService` so the Postgres normalized tables (and the
 * normalized Mongo collections) stay current without polling.
 *
 * Caller is responsible for already having an up-to-date `tekmetric_work_orders`
 * cache row — we read VIN / customer fields off it (and fall back to live
 * /vehicles + /customers fetches) when the webhook payload alone isn't enough
 * to satisfy the adapter (which needs full `vehicle` and `customer` subdocs).
 *
 * Soft-fail by design: any error is logged but never thrown, because the webhook
 * must always 200 OK back to Tekmetric regardless of dual-write health.
 *
 * See TEKMETRIC_5K_SCALING_PLAN.md (Step 2 Phase B).
 */
async function runWebhookNormalizedIngestion(
  db: Db,
  tekmetricShopId: number,
  repairOrder: any,
  cached: any | null,
): Promise<void> {
  try {
    const shop = await db.collection("shops").findOne({ "tekmetric.shopId": tekmetricShopId });
    if (!shop?.shopId) {
      console.log(`[Tekmetric Webhook NIS] No internal shop found for tekmetricShopId=${tekmetricShopId}; skipping NIS`);
      return;
    }
    const internalShopId = Number(shop.shopId);
    const enterpriseId = shop?.enterpriseId as string | undefined;

    // The Tekmetric adapter needs full `vehicle` and `customer` objects, not
    // just IDs. Try cache fields first to avoid an API call; fall back to live
    // fetch when missing. ~150 webhook events/hr × 2 lookups = 300/hr — well
    // under the 600/min budget.
    let vehicle: any = null;
    if (cached?.vin) {
      vehicle = {
        id: repairOrder.vehicleId,
        vin: cached.vin,
        year: cached.vehicleYear,
        make: cached.vehicleMake,
        model: cached.vehicleModel,
        engine: cached.vehicleEngine,
      };
    } else if (repairOrder.vehicleId) {
      try { vehicle = await getVehicle(repairOrder.vehicleId); } catch {}
    }
    if (!vehicle?.vin) {
      // Without a VIN the adapter rejects the work order. Polling will catch up.
      console.log(`[Tekmetric Webhook NIS] No VIN available for RO ${repairOrder.id}; skipping NIS (poll will reconcile)`);
      return;
    }

    let customer: any = null;
    if (repairOrder.customer && (repairOrder.customer.firstName || repairOrder.customer.lastName)) {
      customer = repairOrder.customer;
    } else if (repairOrder.customerId) {
      try { customer = await getCustomer(repairOrder.customerId, internalShopId); } catch {}
    }

    const enriched = { ...repairOrder, vehicle, customer };

    const ingestionService = new NormalizedIngestionService(
      db,
      "tekmetric",
      internalShopId,
      enterpriseId,
      { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true, ingestionVia: "webhook" },
    );
    const result = await ingestionService.ingestWorkOrderBatchWithAllEntities([enriched]);
    console.log(
      `[Tekmetric Webhook NIS] shop=${internalShopId} ro=${repairOrder.id} → WO ${result.workOrders.created}c/${result.workOrders.updated}u/${result.workOrders.skipped}s, payments=${result.payments.created}, inspections=${result.inspections.created}`
    );
  } catch (err: any) {
    console.error(`[Tekmetric Webhook NIS] error for RO ${repairOrder?.id}:`, err?.message);
  }
}

function forwardWebhook(body: any, sourceHost: string) {
  const targets = (process.env.WEBHOOK_FORWARD_TARGETS || "").split(",").map(t => t.trim()).filter(Boolean);
  if (targets.length === 0) return;

  for (const target of targets) {
    if (sourceHost && target.includes(sourceHost)) continue;

    const url = target.startsWith("http") ? target : `https://${target}/api/webhooks/tekmetric`;
    const forwardUrl = url.includes("/api/webhooks/tekmetric") ? url : `${url}/api/webhooks/tekmetric`;

    fetch(forwardUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-From": sourceHost || "unknown",
        "X-Webhook-Forward": "true",
      },
      body: JSON.stringify(body),
    }).then(res => {
      console.log(`[Tekmetric Webhook] Forwarded to ${forwardUrl}: ${res.status}`);
    }).catch(err => {
      console.warn(`[Tekmetric Webhook] Forward to ${forwardUrl} failed: ${err.message}`);
    });
  }
}

// Capture the headers we want to introspect (Step 3b). Persisted into
// `tekmetric_webhook_logs.headers` so we can confirm Tekmetric's actual
// signature header name/format, then turn on enforcement with confidence.
const HEADERS_TO_CAPTURE = [
  "x-tekmetric-signature",
  "x-tekmetric-event",
  "x-tekmetric-delivery",
  "x-signature",
  "x-hub-signature",
  "x-hub-signature-256",
  "user-agent",
  "content-type",
];

function captureHeaders(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HEADERS_TO_CAPTURE) {
    const v = req.headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}

/**
 * Step 3b — HMAC signature verification framework.
 *
 * Default behavior: if `TEKMETRIC_WEBHOOK_SIGNING_SECRET` is unset, we skip
 * verification entirely (matches pre-3b behavior — accept everything).
 *
 * When the secret IS set, we require a valid HMAC-SHA256 signature in the
 * configured header. The header name and algorithm are env-tunable so we can
 * adjust once Tekmetric confirms the exact format (the captured headers in
 * `tekmetric_webhook_logs.headers` make this introspectable).
 *
 * Returns null if OK, or an error string for a 401 response.
 */
function verifySignature(rawBody: string, req: NextRequest): string | null {
  const secret = process.env.TEKMETRIC_WEBHOOK_SIGNING_SECRET;
  if (!secret) return null; // verification disabled

  const headerName = (process.env.TEKMETRIC_WEBHOOK_SIGNATURE_HEADER || "x-tekmetric-signature").toLowerCase();
  const algo = process.env.TEKMETRIC_WEBHOOK_SIGNATURE_ALGO || "sha256";
  // Encoding can be "hex" (default) or "base64" — Tekmetric's exact format will
  // be confirmed from the captured headers (3b introspection) before enabling.
  const encoding = (process.env.TEKMETRIC_WEBHOOK_SIGNATURE_ENCODING || "hex").toLowerCase();
  const provided = req.headers.get(headerName);
  if (!provided) return `missing signature header: ${headerName}`;

  const crypto = require("crypto");
  const expected = crypto.createHmac(algo, secret).update(rawBody).digest(encoding);

  // Strip a "sha256=" / "hmac-sha256=" prefix if present (common formats).
  const normalized = provided.includes("=") && provided.indexOf("=") < provided.length - 1
    ? provided.substring(provided.indexOf("=") + 1)
    : provided;

  try {
    const a = encoding === "base64"
      ? Buffer.from(expected, "base64")
      : Buffer.from(expected, "hex");
    const b = encoding === "base64"
      ? Buffer.from(normalized, "base64")
      : Buffer.from(normalized, "hex");
    if (a.length !== b.length || a.length === 0) return "signature length mismatch";
    if (!crypto.timingSafeEqual(a, b)) return "signature mismatch";
    return null;
  } catch (err: any) {
    return `signature parse error: ${err?.message || "unknown"}`;
  }
}

export async function POST(req: NextRequest) {
  try {
    // Read raw bytes first so signature verification (Step 3b) can run
    // before JSON parse. JSON.parse below works on the same buffer.
    const rawBody = await req.text();
    const capturedHeaders = captureHeaders(req);

    const sigError = verifySignature(rawBody, req);
    if (sigError) {
      console.warn(`[Tekmetric Webhook] Signature rejected: ${sigError}`);
      return NextResponse.json({ error: "invalid_signature", detail: sigError }, { status: 401 });
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch (err: any) {
      return NextResponse.json({ error: "invalid_json", detail: err?.message }, { status: 400 });
    }

    const db = await getDb();

    const isForwarded = req.headers.get("x-webhook-forward") === "true";
    const sourceHost = req.headers.get("host") || "";

    if (!isForwarded) {
      forwardWebhook(body, sourceHost);
    }
    
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

        // Persist the rich webhook payload onto the cache row so future readers
        // (planning, dashboards, re-indexing) don't need to call /repair-orders
        // or /jobs to recover this data. This is the core of the
        // trust-the-webhooks migration — see TEKMETRIC_5K_SCALING_PLAN.md.
        const terminalUpdate: any = {
          status: statusName || "Posted",
          statusCode: statusCode || "POSTED",
          tekmetricShopId,
          closedAt: new Date(),
          updatedAt: new Date(),
          fetchedAt: new Date(),
        };
        if (repairOrder && typeof repairOrder === "object") terminalUpdate.data = repairOrder;
        if (repairOrder?.completedDate) terminalUpdate.completedDate = repairOrder.completedDate;
        if (repairOrder?.postedDate) terminalUpdate.postedDate = repairOrder.postedDate;
        if (repairOrder?.repairOrderNumber != null) terminalUpdate.workOrderNumber = repairOrder.repairOrderNumber;
        if (repairOrder?.customerId != null) terminalUpdate.customerId = repairOrder.customerId;
        if (repairOrder?.vehicleId != null) terminalUpdate.vehicleId = repairOrder.vehicleId;
        const terminalOdometer = repairOrder?.milesOut || repairOrder?.milesIn;
        if (terminalOdometer && terminalOdometer > 0) terminalUpdate.odometer = terminalOdometer;

        // Upsert (instead of updateMany) so terminal-first webhooks for brand-new
        // ROs that have never been seen non-terminal still create a cache row +
        // get indexed in the same call. Scoped by tekmetricShopId to avoid any
        // cross-shop collision on workOrderId.
        const result = await db.collection("tekmetric_work_orders").updateOne(
          { tekmetricShopId, workOrderId: String(roId) },
          {
            $set: terminalUpdate,
            $setOnInsert: { workOrderId: String(roId), createdAt: new Date() },
          },
          { upsert: true }
        );

        const cached = await db.collection("tekmetric_work_orders").findOne({
          tekmetricShopId,
          workOrderId: String(roId),
        });

        if (cached && !cached.jobsIndexed && cached.vin) {
          const shop = await db.collection("shops").findOne({
            "tekmetric.shopId": tekmetricShopId
          });

          if (shop) {
            try {
              // Pass jobs[] directly from the webhook payload when present, so
              // we never need to call /jobs as a fallback. Falls back to cached
              // payload if webhook omitted them.
              const preloadedJobs = Array.isArray(repairOrder?.jobs) && repairOrder.jobs.length > 0
                ? repairOrder.jobs
                : (Array.isArray(cached?.data?.jobs) ? cached.data.jobs : undefined);

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
                repairOrder?.completedDate || repairOrder?.postedDate || new Date().toISOString(),
                cached.odometer ?? terminalOdometer ?? null,
                { indexedVia: "webhook", preloadedJobs }
              );

              console.log(`[Tekmetric Webhook] Indexed ${jobsIndexed} jobs for RO #${roNumber} (via=webhook, preloaded=${!!preloadedJobs})`);

              await db.collection("tekmetric_work_orders").updateOne(
                { tekmetricShopId, workOrderId: String(roId) },
                { $set: { jobsIndexed: true } }
              );
            } catch (err: any) {
              console.error(`[Tekmetric Webhook] Job indexing failed for RO #${roNumber}:`, err.message);
            }
          }
        }

        // Opportunistic jobs-cache warming. The indexer above already warms
        // the cache when it runs, but a terminal webhook for an RO that's
        // already been indexed won't re-enter that path — yet it's still
        // a free, fresh `jobs[]` payload from Tekmetric. Writing it here
        // refreshes the 30d TTL so backfill verification reruns of recently
        // active shops keep hitting Mongo instead of `/jobs?repairOrderId=…`.
        // We cache empty arrays too: a terminal RO with no jobs is a stable
        // answer and the next backfill run shouldn't pay another API call to
        // re-confirm it. See task #57 + the `tekmetric_jobs_cache` notes in
        // lib/tekmetric-incremental-sync.ts.
        if (Array.isArray(repairOrder?.jobs)) {
          const webhookJobs = repairOrder.jobs;
          try {
            await db.collection("tekmetric_jobs_cache").updateOne(
              { repairOrderId: roId },
              {
                $set: {
                  repairOrderId: roId,
                  jobs: webhookJobs,
                  cachedAt: new Date(),
                },
              },
              { upsert: true }
            );
          } catch (warmErr: any) {
            console.warn(`[Tekmetric Webhook] jobs cache warm failed for RO #${roNumber}: ${warmErr?.message || warmErr}`);
          }
        }

        // Phase B: dual-write into normalized tables. Soft-fail; webhook still 200s.
        await runWebhookNormalizedIngestion(db, tekmetricShopId, repairOrder, cached);

        const wasInsert = !!result.upsertedId;
        console.log(`[Tekmetric Webhook] Terminal cache write for RO #${roNumber} (${wasInsert ? "INSERT" : "UPDATE"}) → ${statusName || "Posted"}`);
      } else {
        // Always upsert the work order row from whatever the webhook payload contains, so that
        // a missing vehicle/customer never leaves us with no row at all. Vehicle/customer
        // enrichment runs after the upsert and patches in whatever it can fetch.
        const existingWO = await db.collection("tekmetric_work_orders").findOne({
          workOrderId: String(roId)
        });

        const shop = await db.collection("shops").findOne({
          "tekmetric.shopId": tekmetricShopId
        });

        const newLabel = repairOrder.repairOrderCustomLabel?.name || repairOrder.repairOrderLabel?.name || null;
        const DVI_LABEL_RE = /\binsp|dvi\b|\bmulti.?point|\bcourtesy.check|\bcomplimentary.check/i;
        const dviFromLabel = newLabel && DVI_LABEL_RE.test(newLabel);
        const newOdometer = repairOrder.milesIn || repairOrder.milesOut;
        const payloadCustomerName =
          repairOrder.customerName ||
          (repairOrder.customer?.firstName || repairOrder.customer?.lastName
            ? `${repairOrder.customer.firstName || ''} ${repairOrder.customer.lastName || ''}`.trim()
            : null);

        const setFields: any = {
          workOrderNumber: roNumber,
          tekmetricShopId,
          status: statusName,
          statusCode,
          label: newLabel,
          labelColor: repairOrder.color || null,
          updatedAt: new Date(),
          fetchedAt: new Date(),
        };
        if (shop?.shopId != null) setFields.shopId = String(shop.shopId);
        if (newOdometer && newOdometer > 0) setFields.odometer = newOdometer;
        if (payloadCustomerName) setFields.customerName = payloadCustomerName;
        if (repairOrder.customerId != null) setFields.customerId = repairOrder.customerId;
        if (dviFromLabel && !existingWO?.dviDone) setFields.dviDone = true;
        // Persist the rich webhook payload (including jobs[], dates, totals) onto
        // the cache row. This is what lets the terminal-status path index jobs
        // without falling back to a /jobs API call. See TEKMETRIC_5K_SCALING_PLAN.md.
        setFields.data = repairOrder;
        if (repairOrder.createdDate) setFields.createdDate = repairOrder.createdDate;
        if (repairOrder.updatedDate) setFields.updatedDate = repairOrder.updatedDate;
        if (repairOrder.completedDate) setFields.completedDate = repairOrder.completedDate;
        if (repairOrder.vehicleId != null) setFields.vehicleId = repairOrder.vehicleId;

        const setOnInsert: any = {
          workOrderId: String(roId),
          createdAt: new Date(),
        };

        const upsertResult = await db.collection("tekmetric_work_orders").updateOne(
          { workOrderId: String(roId) },
          { $set: setFields, $setOnInsert: setOnInsert },
          { upsert: true }
        );
        const wasInsert = !!upsertResult.upsertedId;
        console.log(
          `[Tekmetric Webhook] Upserted RO #${roNumber}: ${wasInsert ? 'INSERT' : 'UPDATE'} status=${statusName}, label=${newLabel}, odometer=${newOdometer || 'unchanged'}, customer=${payloadCustomerName || 'unchanged'}, shop=${shop?.shopId || 'unknown'}`
        );

        // Enrich with vehicle + customer data if we're missing it. Fetches are independent and run
        // in parallel; partial failures still preserve whatever data did come back.
        const needsVehicle = !!repairOrder.vehicleId && !(existingWO?.vin);
        const needsCustomer =
          !!repairOrder.customerId &&
          !(existingWO?.customerName && existingWO.customerName !== "Unknown Customer") &&
          !payloadCustomerName;

        if (shop && (needsVehicle || needsCustomer)) {
          const [vehicleResult, customerResult] = await Promise.allSettled([
            needsVehicle ? getVehicle(repairOrder.vehicleId) : Promise.resolve(null),
            needsCustomer ? getCustomer(repairOrder.customerId, shop?.shopId ? Number(shop.shopId) : undefined) : Promise.resolve(null),
          ]);

          const enrichFields: any = {};
          let enrichedVin: string | null = null;
          let enrichedMileage: number | null = null;

          if (vehicleResult.status === 'fulfilled' && vehicleResult.value) {
            const vehicle: any = vehicleResult.value;
            if (vehicle.vin) {
              enrichedVin = String(vehicle.vin).toUpperCase();
              enrichFields.vin = enrichedVin;
            }
            if (vehicle.year != null) enrichFields.vehicleYear = vehicle.year;
            if (vehicle.make) enrichFields.vehicleMake = vehicle.make;
            if (vehicle.model) enrichFields.vehicleModel = vehicle.model;
            if (vehicle.engine) enrichFields.vehicleEngine = vehicle.engine;
            const vehicleMileage = vehicle.mileageIn || vehicle.mileageOut;
            if (!enrichFields.odometer && !setFields.odometer && vehicleMileage > 0) {
              enrichFields.odometer = vehicleMileage;
              enrichedMileage = vehicleMileage;
            }
          } else if (vehicleResult.status === 'rejected') {
            console.error(`[Tekmetric Webhook] Vehicle enrichment failed for RO #${roNumber}, vehicleId=${repairOrder.vehicleId}:`, (vehicleResult.reason as any)?.message);
          }

          if (customerResult.status === 'fulfilled' && customerResult.value) {
            const customer: any = customerResult.value;
            const fullName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim();
            if (fullName) enrichFields.customerName = fullName;
          } else if (customerResult.status === 'rejected') {
            console.error(`[Tekmetric Webhook] Customer enrichment failed for RO #${roNumber}, customerId=${repairOrder.customerId}:`, (customerResult.reason as any)?.message);
          }

          if (Object.keys(enrichFields).length > 0) {
            enrichFields.updatedAt = new Date();
            await db.collection("tekmetric_work_orders").updateOne(
              { workOrderId: String(roId) },
              { $set: enrichFields }
            );
            console.log(`[Tekmetric Webhook] Enriched RO #${roNumber} with: ${Object.keys(enrichFields).filter(k => k !== 'updatedAt').join(', ')}`);
          }

          // Trigger VHI build once we have vin + mileage (from payload, existing row, or enrichment)
          const finalVin = enrichedVin || existingWO?.vin;
          const finalMileage =
            (newOdometer && newOdometer > 0 ? newOdometer : null) ||
            enrichedMileage ||
            (existingWO?.odometer || null);
          if (finalVin && finalMileage && finalMileage > 0) {
            triggerVhiOnWorkOrderCreate(db, {
              vin: finalVin,
              shopId: Number(shop.shopId),
              provider: "tekmetric",
              roNumber: String(roNumber),
              mileage: finalMileage,
              source: "webhook",
            }).catch((err: any) =>
              console.error(`[Tekmetric Webhook] VHI create-build failed for VIN ${finalVin}:`, err.message)
            );
          }
        } else if (existingWO?.vin && newOdometer && newOdometer > 0 && shop) {
          // Existing row already has vehicle info; just trigger VHI on mileage update
          triggerVhiOnWorkOrderCreate(db, {
            vin: existingWO.vin,
            shopId: Number(shop.shopId),
            provider: "tekmetric",
            roNumber: String(roNumber),
            mileage: newOdometer,
            source: "webhook",
          }).catch((err: any) =>
            console.error(`[Tekmetric Webhook] VHI create-build on update failed for VIN ${existingWO.vin}:`, err.message)
          );
        }

        if (!shop) {
          console.warn(`[Tekmetric Webhook] No MOS shop found for tekmetric.shopId=${tekmetricShopId}; row was upserted with shopId=unknown`);
        }

        // Phase B: dual-write to normalized tables. Re-read the cache row so any
        // enrichment we just performed (vin/year/make/model) is reflected.
        const refreshedCached = await db.collection("tekmetric_work_orders").findOne(
          { workOrderId: String(roId) }
        );
        await runWebhookNormalizedIngestion(db, tekmetricShopId, repairOrder, refreshedCached);
      }
      
      try {
        const shop = await db.collection("shops").findOne(
          { "tekmetric.shopId": tekmetricShopId },
          { projection: { shopId: 1 } }
        );
        
        if (shop) {
          const cachedWO = await db.collection("tekmetric_work_orders").findOne(
            { workOrderId: String(roId) },
            { projection: { vin: 1, odometer: 1 } }
          );
          
          const vin = cachedWO?.vin;
          
          if (vin) {
            if (isTerminal || isInvoicePosted) {
              await invalidateCachedPlan(db, vin, Number(shop.shopId));
              console.log(`[Tekmetric Webhook] Invalidated plan cache for VIN ${vin} (shop ${shop.shopId})`);

              const authorizedJobs = extractAuthorizedJobsFromTekmetricRo(repairOrder);
              triggerVhiOnWorkOrderClose(db, {
                vin,
                shopId: Number(shop.shopId),
                provider: "tekmetric",
                roNumber: String(roNumber),
                mileage: cachedWO?.odometer || repairOrder.milesIn || repairOrder.milesOut || null,
                authorizedJobs,
                source: "webhook",
              }).catch((err: any) =>
                console.error(`[Tekmetric Webhook] VHI auto-rebuild failed for VIN ${vin}:`, err.message)
              );
            }
          }
        }
      } catch (err: any) {
        console.error(`[Tekmetric Webhook] VHI trigger failed for RO #${roNumber}:`, err.message);
      }
    }
    
    if (isInspectionComplete) {
      const repairOrderId = data.repairOrderId || data.repair_order_id || data.roId;
      const inspectionData = data;
      
      if (repairOrderId) {
        // Phase C: fetch the FULL inspection task list now that we know it's
        // ready, so plan-build / VHI no longer relies on polling to pull this
        // in. Look up the cache row first to get tekmetricShopId + the prior
        // RO payload (Phase A persisted `data: repairOrder` on the cache row).
        const cached = await db.collection("tekmetric_work_orders").findOne(
          { workOrderId: String(repairOrderId) }
        );
        const tekShopIdForInsp =
          (data as any).shopId ||
          cached?.tekmetricShopId ||
          cached?.data?.shopId ||
          null;

        let fetchedInspections: any[] | null = null;
        if (tekShopIdForInsp) {
          try {
            const shopForInsp = await db.collection("shops").findOne(
              { "tekmetric.shopId": Number(tekShopIdForInsp) },
              { projection: { "tekmetric.xAuthToken": 1, shopId: 1 } }
            );
            const xAuthToken = shopForInsp?.tekmetric?.xAuthToken || null;
            if (xAuthToken) {
              fetchedInspections = await getRepairOrderInspectionsWithXAuth(
                Number(repairOrderId),
                Number(tekShopIdForInsp),
                xAuthToken
              );
              console.log(`[Tekmetric Webhook] Fetched ${fetchedInspections?.length ?? 0} full inspection(s) for RO ${repairOrderId} (via=webhook)`);
            } else {
              console.log(`[Tekmetric Webhook] No xAuthToken for tek shop ${tekShopIdForInsp}; skipping full inspection fetch (poll fallback if enabled)`);
            }
          } catch (err: any) {
            console.error(`[Tekmetric Webhook] Inspection fetch failed for RO ${repairOrderId}:`, err.message);
          }
        }

        // Persist on the cache row. Replace `inspections` with the freshly
        // fetched full list when we got it; otherwise fall back to recording
        // the partial event payload so we at least know it happened.
        const inspectionsSet =
          Array.isArray(fetchedInspections) && fetchedInspections.length > 0
            ? fetchedInspections
            : null;
        const update: any = {
          $set: {
            dviDone: true,
            dviCompletedAt: new Date(),
            lastInspection: inspectionData,
          },
        };
        if (inspectionsSet) {
          update.$set.inspections = inspectionsSet;
          update.$set.inspectionsFetchedAt = new Date();
          update.$set.inspectionsSource = "webhook";
        } else {
          update.$push = {
            inspections: { ...inspectionData, receivedAt: new Date() },
          };
        }
        const result = await db.collection("tekmetric_work_orders").updateMany(
          { workOrderId: String(repairOrderId) },
          update
        );
        console.log(`[Tekmetric Webhook] Marked RO ${repairOrderId} as DVI complete. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}, fullInspections=${!!inspectionsSet}`);

        // Phase C: dual-write inspections through NIS so normalized tables
        // pick up the freshly-fetched DVI data without waiting for polling.
        if (inspectionsSet && tekShopIdForInsp && cached?.data) {
          const enrichedRo = { ...cached.data, inspections: inspectionsSet };
          const refreshedCached = await db.collection("tekmetric_work_orders").findOne(
            { workOrderId: String(repairOrderId) }
          );
          await runWebhookNormalizedIngestion(
            db,
            Number(tekShopIdForInsp),
            enrichedRo,
            refreshedCached
          );
        }

        // Invalidate plan cache since DVI results affect recommendations
        try {
          const woForDvi = await db.collection("tekmetric_work_orders").findOne(
            { workOrderId: String(repairOrderId) },
            { projection: { vin: 1, shopId: 1 } }
          );
          if (woForDvi?.vin && woForDvi?.shopId) {
            await invalidateCachedPlan(db, woForDvi.vin, Number(woForDvi.shopId));
            console.log(`[Tekmetric Webhook] Invalidated plan cache for DVI complete on VIN ${woForDvi.vin}`);
          }
        } catch (err: any) {
          console.error(`[Tekmetric Webhook] DVI plan cache invalidation failed:`, err.message);
        }
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
      headers: capturedHeaders, // Step 3b: introspectable header capture
      receivedAt: new Date()
    });
    
    await db.collection("dashboard_updates").updateOne(
      { _id: "lastUpdate" } as any,
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
  const targets = (process.env.WEBHOOK_FORWARD_TARGETS || "").split(",").map(t => t.trim()).filter(Boolean);
  return NextResponse.json({ 
    status: "Tekmetric webhook endpoint active",
    events: [
      "InspectionComplete",
      "CustomerViewedInspection",
      "RepairOrder.Posted",
      "RepairOrder.Invoiced",
      "RepairOrder.Updated"
    ],
    forwardingTo: targets.length > 0 ? targets : "none",
    webhookUrl: process.env.REPLIT_DEV_DOMAIN 
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/webhooks/tekmetric`
      : "/api/webhooks/tekmetric"
  });
}
