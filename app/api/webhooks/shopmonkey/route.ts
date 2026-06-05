import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import type { Db } from "mongodb";
import { getOrder, getVehicle, getCustomer } from "@/lib/integrations/shopmonkey/client";
import { invalidateCachedPlan } from "@/lib/plan-cache";
import { NormalizedIngestionService } from "@/lib/integrations/core/normalized-ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shopmonkey webhook receiver — mirrors the Tekmetric webhook
 * (app/api/webhooks/tekmetric/route.ts) end-to-end:
 *
 *   1. Read raw bytes first so HMAC signature verification can run before
 *      JSON.parse (signature is over the raw body).
 *   2. Verify the signature only when `SHOPMONKEY_WEBHOOK_SIGNING_SECRET` is
 *      set. Default behavior with no secret = accept everything (matches
 *      Tekmetric's pre-enforcement posture). Header name / algo / encoding are
 *      env-tunable so we can match Shopmonkey's exact format once confirmed.
 *   3. Upsert the rich order payload onto the `shopmonkey_work_orders` cache row
 *      inline so dashboards/planning never need to re-fetch /order/{id}.
 *   4. Defer the heavy NormalizedIngestionService dual-write off the request
 *      thread so the webhook returns fast and always 200s back to Shopmonkey
 *      (soft-fail contract — a failed dual-write never blocks the ack).
 *
 * Amounts in Shopmonkey are in CENTS; the normalized adapter handles the
 * cents → dollars conversion.
 */

type DeferFn = (fn: () => Promise<void>) => void;
const defaultDefer: DeferFn = (fn) => {
  setImmediate(() => {
    fn().catch((err: any) => {
      console.error("[Shopmonkey Webhook] Deferred work failed:", err?.message || err);
    });
  });
};
export const __deps: { getDb: typeof getDb; defer: DeferFn } = {
  getDb,
  defer: defaultDefer,
};

const TERMINAL_STATUSES = ["invoice", "invoiced", "posted", "complete", "completed", "archived", "deleted"];

const HEADERS_TO_CAPTURE = [
  "x-shopmonkey-signature",
  "x-shopmonkey-event",
  "x-shopmonkey-delivery",
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
 * HMAC signature verification — disabled when no secret is set. Mirrors the
 * Tekmetric verifier: configurable header name, algorithm, and encoding so we
 * can match Shopmonkey's confirmed format without a redeploy.
 *
 * Returns null if OK (or disabled), or an error string for a 401 response.
 */
export function __verifySignature(rawBody: string, req: NextRequest): string | null {
  return verifySignature(rawBody, req);
}

function verifySignature(rawBody: string, req: NextRequest): string | null {
  const secret = process.env.SHOPMONKEY_WEBHOOK_SIGNING_SECRET;
  if (!secret) return null; // verification disabled

  const headerName = (process.env.SHOPMONKEY_WEBHOOK_SIGNATURE_HEADER || "x-shopmonkey-signature").toLowerCase();
  const algo = process.env.SHOPMONKEY_WEBHOOK_SIGNATURE_ALGO || "sha256";
  const encoding = (process.env.SHOPMONKEY_WEBHOOK_SIGNATURE_ENCODING || "base64").toLowerCase();
  const provided = req.headers.get(headerName);
  if (!provided) return `missing signature header: ${headerName}`;

  const crypto = require("crypto");
  const expected = crypto.createHmac(algo, secret).update(rawBody).digest(encoding);

  const normalized = provided.includes("=") && provided.indexOf("=") < provided.length - 1
    ? provided.substring(provided.indexOf("=") + 1)
    : provided;

  try {
    const a = encoding === "base64" ? Buffer.from(expected, "base64") : Buffer.from(expected, "hex");
    const b = encoding === "base64" ? Buffer.from(normalized, "base64") : Buffer.from(normalized, "hex");
    if (a.length !== b.length || a.length === 0) return "signature length mismatch";
    if (!crypto.timingSafeEqual(a, b)) return "signature mismatch";
    return null;
  } catch (err: any) {
    return `signature parse error: ${err?.message || "unknown"}`;
  }
}

/**
 * Find the internal MOS shop for a Shopmonkey order. Shopmonkey identifies a
 * shop by `locationId` (preferred) or `companyId`, persisted onto the shop doc
 * under `shopmonkey.locationId` / `shopmonkey.companyId`.
 */
async function findShopForOrder(db: Db, order: any): Promise<any | null> {
  const locationId = order.locationId ?? order.location?.id;
  const companyId = order.companyId ?? order.company?.id;
  const or: any[] = [];
  if (locationId != null) or.push({ "shopmonkey.locationId": String(locationId) });
  if (companyId != null) or.push({ "shopmonkey.companyId": String(companyId) });
  if (or.length === 0) return null;
  return db.collection("shops").findOne({ $or: or });
}

/**
 * Phase B dual-write into the normalized tables — soft-fail, deferred. Mirrors
 * the Tekmetric webhook's runWebhookNormalizedIngestion: enrich the order with
 * full vehicle / customer subdocs (cache first, live fetch fallback) so the
 * adapter has what it needs, then ingest a single-order batch.
 */
async function runWebhookNormalizedIngestion(
  db: Db,
  shop: any,
  order: any,
): Promise<void> {
  try {
    const internalShopId = Number(shop.shopId);
    const enterpriseId = shop?.enterpriseId as string | undefined;

    let vehicle: any = order.vehicle || null;
    if (!vehicle?.vin && order.vehicleId) {
      try { vehicle = await getVehicle(internalShopId, String(order.vehicleId)); } catch {}
    }
    if (!vehicle?.vin) {
      console.log(`[Shopmonkey Webhook NIS] No VIN available for order ${order.id}; skipping NIS (poll will reconcile)`);
      return;
    }

    let customer: any = order.customer || null;
    if (!(customer?.firstName || customer?.lastName) && order.customerId) {
      try { customer = await getCustomer(internalShopId, String(order.customerId)); } catch {}
    }

    const enriched = { ...order, vehicle, customer };

    const ingestionService = new NormalizedIngestionService(
      db,
      "shopmonkey",
      internalShopId,
      enterpriseId,
      { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true, ingestionVia: "webhook" },
    );
    const result = await ingestionService.ingestWorkOrderBatchWithAllEntities([enriched]);
    console.log(
      `[Shopmonkey Webhook NIS] shop=${internalShopId} order=${order.id} → WO ${result.workOrders.created}c/${result.workOrders.updated}u/${result.workOrders.skipped}s, serviceJobs ${result.serviceJobs.created}c/${result.serviceJobs.updated}u/${result.serviceJobs.skipped}s/${result.serviceJobs.errors}e, lineItems ${result.lineItems.created}c/${result.lineItems.updated}u/${result.lineItems.skipped}s/${result.lineItems.errors}e, payments=${result.payments.created}, inspections=${result.inspections.created}`,
    );
  } catch (err: any) {
    console.error(`[Shopmonkey Webhook NIS] error for order ${order?.id}:`, err?.message);
  }
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const rawBody = await req.text();
    captureHeaders(req);

    const sigError = verifySignature(rawBody, req);
    if (sigError) {
      console.warn(`[Shopmonkey Webhook] Signature rejected: ${sigError}`);
      return NextResponse.json({ error: "invalid_signature", detail: sigError }, { status: 401 });
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch (err: any) {
      return NextResponse.json({ error: "invalid_json", detail: err?.message }, { status: 400 });
    }

    const db = await __deps.getDb();

    console.log("[Shopmonkey Webhook] Received event:", JSON.stringify(body, null, 2).slice(0, 1000));

    const eventType = body.event || body.eventType || body.type || "";
    const data = body.data || body.payload || body;
    // Handle nested (data.order) and flat (data is the order) structures.
    const order = data.order || body.order || (data.id ? data : null);

    if (!order || !order.id) {
      console.log(`[Shopmonkey Webhook] No order in payload (event="${eventType}"); acking.`);
      return NextResponse.json({ ok: true, ignored: true }, { status: 200 });
    }

    const orderId = String(order.id);
    const orderNumber = order.number ?? order.invoiceNumber ?? orderId;
    const statusName = String(order.status || "");

    console.log(`[Shopmonkey Webhook] received order #${orderNumber} event=${eventType} status=${statusName}`);

    const shop = await findShopForOrder(db, order);
    if (!shop?.shopId) {
      console.warn(`[Shopmonkey Webhook] No MOS shop found for order #${orderNumber} (locationId=${order.locationId ?? order.location?.id}, companyId=${order.companyId ?? order.company?.id}); acking.`);
      return NextResponse.json({ ok: true, unmatchedShop: true }, { status: 200 });
    }

    const isTerminal = TERMINAL_STATUSES.some((s) => statusName.toLowerCase().includes(s));

    const setFields: any = {
      shopId: String(shop.shopId),
      workOrderNumber: String(orderNumber),
      status: statusName,
      data: order,
      updatedAt: new Date(),
      fetchedAt: new Date(),
    };
    if (order.locationId != null) setFields.locationId = String(order.locationId);
    if (order.companyId != null) setFields.companyId = String(order.companyId);
    if (order.vehicleId != null) setFields.vehicleId = String(order.vehicleId);
    if (order.customerId != null) setFields.customerId = String(order.customerId);
    if (order.vehicle?.vin) setFields.vin = order.vehicle.vin;
    const odometer = order.mileageOut || order.mileageIn || order.mileage;
    if (odometer && odometer > 0) setFields.odometer = odometer;
    if (order.completedDate) setFields.completedDate = order.completedDate;
    if (order.postedDate) setFields.postedDate = order.postedDate;
    if (isTerminal) setFields.closedAt = new Date();

    const upsertResult = await db.collection("shopmonkey_work_orders").updateOne(
      { workOrderId: orderId },
      {
        $set: setFields,
        $setOnInsert: { workOrderId: orderId, createdAt: new Date() },
      },
      { upsert: true },
    );
    const wasInsert = !!upsertResult.upsertedId;
    console.log(`[Shopmonkey Webhook] Upserted order #${orderNumber}: ${wasInsert ? "INSERT" : "UPDATE"} status=${statusName}, shop=${shop.shopId}`);

    // Bump dashboard freshness by invalidating any cached plan for this vehicle.
    if (order.vehicle?.vin) {
      try {
        await invalidateCachedPlan(Number(shop.shopId), order.vehicle.vin);
      } catch (err: any) {
        console.warn(`[Shopmonkey Webhook] plan-cache invalidate failed for order #${orderNumber}: ${err?.message}`);
      }
    }

    // Defer the heavy NIS dual-write off the request thread (soft-fail).
    __deps.defer(() => runWebhookNormalizedIngestion(db, shop, order));

    console.log(`[Shopmonkey Webhook] order #${orderNumber} handled inline in ${Date.now() - startTime}ms`);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err: any) {
    console.error("[Shopmonkey Webhook] Handler error:", err?.message || err);
    // Soft-fail: still 200 so Shopmonkey doesn't hammer retries on our bug.
    return NextResponse.json({ ok: true, error: err?.message || "unknown" }, { status: 200 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
