import { NextResponse, NextRequest } from "next/server";
import { getRepairOrder, getVehicle, getCustomer } from "@/lib/integrations/shopware/client";
import {
  transformRepairOrder,
  transformVehicle,
  transformCustomer,
} from "@/lib/integrations/shopware/transform";
import type { ShopWareRepairOrder } from "@/lib/integrations/shopware/types";
import { extractAuthorizedJobsFromShopWareRo } from "@/lib/vhi-webhook-trigger";
import { findShopByQuery } from "@/lib/data/repositories/shops";
import {
  fireVhiOnWorkOrderClose,
  fireVhiOnWorkOrderCreate,
  insertWebhookLog,
  markRepairOrderDeleted,
  markWebhookFailed,
  markWebhookProcessed,
  prefetchPlanIfNeeded,
  touchDashboardUpdate,
  upsertCustomer,
  upsertRepairOrder,
  upsertShopwareJobIndexEntries,
  upsertVehicle,
} from "@/lib/data/repositories/shopware-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verifySecret(req: NextRequest): boolean {
  const incoming = req.headers.get("x-api-secret") ?? req.headers.get("X-Api-Secret");
  const expected = process.env.SHOPWARE_API_SECRET;
  if (!expected) return false;
  return incoming === expected;
}

async function findShopByTenant(tenantId: number, roShopId?: number) {
  const projection: Record<string, 0 | 1> = {
    shopId: 1,
    name: 1,
    "shopware.swShopId": 1,
  };
  const query: Record<string, unknown> = { "shopware.tenantId": tenantId };
  if (roShopId) {
    query["shopware.swShopId"] = roShopId;
  }
  const shop = await findShopByQuery(query, projection);
  if (shop) return shop;
  if (roShopId) {
    return findShopByQuery({ "shopware.tenantId": tenantId }, projection);
  }
  return null;
}

function extractShopwareJobIndex(
  mosShopId: number,
  ro: ShopWareRepairOrder,
  tenantId: number
) {
  const vin = ro.vehicle?.vin?.toUpperCase() ?? null;
  const entries = [];

  const roMileage =
    (typeof (ro as any).odometer_out === "number" && (ro as any).odometer_out > 0 ? (ro as any).odometer_out : null) ??
    (typeof (ro as any).odometer === "number" && (ro as any).odometer > 0 ? (ro as any).odometer : null) ??
    (typeof (ro as any).odometer_in === "number" && (ro as any).odometer_in > 0 ? (ro as any).odometer_in : null) ??
    null;

  for (const service of ro.services ?? []) {
    const laborHours = (service.labors ?? []).reduce((s, l) => s + l.hours, 0);
    const partsAmount = (service.parts ?? []).reduce(
      (s, p) => s + ((p.sell_price_cents ?? 0) / 100) * p.quantity,
      0
    );
    const subletsAmount = (service.sublets ?? []).reduce(
      (s, sub) => s + (sub.price_cents ?? 0) / 100,
      0
    );
    let laborAmount = 0;
    if (service.is_fixed_price_service && service.fixed_price_labor_total_cents != null) {
      laborAmount = service.fixed_price_labor_total_cents / 100;
    }
    const totalAmount = laborAmount + partsAmount + subletsAmount;

    entries.push({
      shopId: mosShopId,
      provider: "shopware",
      tenantId,
      workOrderId: String(ro.id),
      workOrderNumber: ro.number,
      servicePackageId: String(service.id),
      title: service.title,
      status: service.completed ? "completed" : "open",
      vin,
      vehicleYear: ro.vehicle?.year ? parseInt(ro.vehicle.year, 10) : undefined,
      vehicleMake: ro.vehicle?.make,
      vehicleModel: ro.vehicle?.model,
      laborHours,
      laborAmount,
      partsAmount,
      totalAmount,
      completedAt: ro.closed_at ? new Date(ro.closed_at) : undefined,
      mileage: roMileage,
      indexedAt: new Date(),
    });
  }

  return entries;
}

async function handleRepairOrderEvent(
  event: string,
  tenantId: number,
  roId: number,
  rawData: any
) {
  const roShopId: number | undefined = rawData?.shop_id ?? undefined;
  const shop = await findShopByTenant(tenantId, roShopId);
  if (!shop) {
    console.warn(`[SW Webhook] No MOS shop found for tenant ${tenantId} shop ${roShopId}`);
    return;
  }

  const mosShopId = Number(shop.shopId);

  if (event === "repair_order.deleted") {
    await markRepairOrderDeleted(mosShopId, roId);
    console.log(`[SW Webhook] Marked RO ${roId} as deleted for shop ${mosShopId}`);
    return;
  }

  let ro: ShopWareRepairOrder | null = null;
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      ro = await getRepairOrder(tenantId, roId, mosShopId);
      break;
    } catch (err: any) {
      const isServerError = err.message?.includes("500") || err.message?.includes("502") || err.message?.includes("503");
      if (isServerError && attempt < maxRetries) {
        const delay = attempt * 2000;
        console.warn(`[SW Webhook] Fetch RO ${roId} attempt ${attempt}/${maxRetries} failed (${err.message}), retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      console.error(`[SW Webhook] Failed to fetch RO ${roId} after ${attempt} attempt(s):`, err.message);

      if (rawData && (rawData.id || rawData.number)) {
        console.log(`[SW Webhook] Using webhook payload as fallback for RO ${roId}`);
        await upsertRepairOrder(mosShopId, roId, {
          mosShopId,
          roId,
          tenantId,
          state: rawData.state ?? null,
          vin: rawData.vehicle?.vin?.toUpperCase() ?? rawData.vin?.toUpperCase() ?? null,
          number: rawData.number ?? null,
          updatedAt: new Date(),
          syncedAt: new Date(),
          partialFromWebhook: true,
          fetchError: err.message,
        });
        console.log(`[SW Webhook] Stored partial RO ${roId} from webhook payload for shop ${mosShopId}`);
      }
      return;
    }
  }

  if (!ro) return;

  const normalized = transformRepairOrder(ro);

  await upsertRepairOrder(mosShopId, roId, {
    mosShopId,
    roId,
    tenantId,
    swShopId: ro.shop_id,
    number: ro.number,
    state: ro.state,
    vin: ro.vehicle?.vin?.toUpperCase() ?? null,
    customerId: ro.customer_id,
    vehicleId: ro.vehicle_id,
    customerName: ro.customer
      ? `${ro.customer.first_name ?? ""} ${ro.customer.last_name ?? ""}`.trim()
      : null,
    vehicleYear: ro.vehicle?.year ? parseInt(ro.vehicle.year, 10) : null,
    vehicleMake: ro.vehicle?.make ?? null,
    vehicleModel: ro.vehicle?.model ?? null,
    odometer: ro.odometer ?? null,
    serviceCount: ro.services?.length ?? 0,
    createdAt: ro.created_at ? new Date(ro.created_at) : null,
    updatedAt: ro.updated_at ? new Date(ro.updated_at) : null,
    closedAt: ro.closed_at ? new Date(ro.closed_at) : null,
    raw: ro,
    syncedAt: new Date(),
  });

  await touchDashboardUpdate();

  console.log(`[SW Webhook] Upserted RO ${roId} (${ro.number}) for shop ${mosShopId} — state: ${ro.state}`);

  // Prefetch maintenance plan for active ROs with VIN + odometer
  const vin = ro.vehicle?.vin?.toUpperCase() ?? null;
  const odometer = ro.odometer ?? null;
  if (vin && vin.length === 17 && odometer && odometer > 0) {
    setImmediate(async () => {
      try {
        const result = await prefetchPlanIfNeeded(mosShopId, vin, odometer);
        if (result.cached) {
          console.log(`[SW Webhook] Plan already cached for ${vin}, skipping prefetch`);
        } else {
          console.log(`[SW Webhook] Prefetching plan for ${vin} at ${odometer} mi (RO ${roId})`);
          console.log(`[SW Webhook] Prefetch complete for ${vin} in ${result.duration}ms`);
        }
      } catch (err: any) {
        console.warn(`[SW Webhook] Prefetch failed for ${vin}:`, err.message);
      }
    });

  }

  const isInvoiced = ro.state === "invoice" || Boolean(ro.closed_at);

  if (!isInvoiced && vin && vin.length === 17 && odometer && odometer > 0) {
    fireVhiOnWorkOrderCreate({
      vin,
      shopId: mosShopId,
      provider: "shopware",
      roNumber: ro.number ? String(ro.number) : null,
      mileage: odometer,
      source: "webhook",
    }).catch((err: any) =>
      console.error(`[SW Webhook] VHI create-build failed for ${vin}:`, err.message)
    );
  }

  if (isInvoiced && ro.vehicle?.vin) {
    try {
      const entries = extractShopwareJobIndex(mosShopId, ro, tenantId);
      const { indexed, skipped } = await upsertShopwareJobIndexEntries(entries);

      if (indexed > 0) {
        console.log(
          `[SW Webhook] Indexed ${indexed} jobs for RO ${roId} (${skipped} unchanged)`
        );
      }
    } catch (err: any) {
      console.error(`[SW Webhook] Job indexing error for RO ${roId}:`, err.message);
    }

    const authorizedJobs = extractAuthorizedJobsFromShopWareRo(ro);
    fireVhiOnWorkOrderClose({
      vin: ro.vehicle?.vin?.toUpperCase(),
      shopId: mosShopId,
      provider: "shopware",
      roNumber: ro.number ? String(ro.number) : null,
      mileage: ro.odometer_out ?? ro.odometer ?? null,
      authorizedJobs,
      source: "webhook",
    }).catch((err: any) =>
      console.error(`[SW Webhook] VHI auto-rebuild failed for RO ${roId}:`, err.message)
    );
  }
}

async function handleVehicleEvent(tenantId: number, vehicleId: number, rawData: any) {
  const shop = await findShopByTenant(tenantId);
  if (!shop) return;
  const mosShopId = Number(shop.shopId);

  try {
    const vehicle = rawData?.vin
      ? rawData
      : await getVehicle(tenantId, vehicleId, mosShopId);

    const normalized = transformVehicle(vehicle);

    await upsertVehicle(mosShopId, vehicleId, {
      mosShopId,
      vehicleId,
      tenantId,
      vin: normalized.vin?.toUpperCase() ?? null,
      year: normalized.year ?? null,
      make: normalized.make ?? null,
      model: normalized.model ?? null,
      licensePlate: normalized.licensePlate ?? null,
      updatedAt: new Date(),
      raw: vehicle,
    });

    console.log(`[SW Webhook] Updated vehicle ${vehicleId} (${normalized.vin ?? "no VIN"}) for shop ${mosShopId}`);
  } catch (err: any) {
    console.error(`[SW Webhook] Failed to update vehicle ${vehicleId}:`, err.message);
  }
}

async function handleCustomerEvent(tenantId: number, customerId: number, rawData: any) {
  const shop = await findShopByTenant(tenantId);
  if (!shop) return;
  const mosShopId = Number(shop.shopId);

  try {
    const customer = rawData?.first_name != null
      ? rawData
      : await getCustomer(tenantId, customerId, mosShopId);

    const normalized = transformCustomer(customer);

    await upsertCustomer(mosShopId, customerId, {
      mosShopId,
      customerId,
      tenantId,
      firstName: normalized.firstName ?? null,
      lastName: normalized.lastName ?? null,
      email: normalized.email ?? null,
      phone: normalized.phone ?? null,
      updatedAt: new Date(),
      raw: customer,
    });

    console.log(`[SW Webhook] Updated customer ${customerId} for shop ${mosShopId}`);
  } catch (err: any) {
    console.error(`[SW Webhook] Failed to update customer ${customerId}:`, err.message);
  }
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    console.warn("[SW Webhook] Invalid or missing X-Api-Secret");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = await req.text();
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const event: string = body?.event ?? "";
  const webhookId: string = body?.id ?? "";
  const timestamp: string = body?.timestamp ?? "";
  const payload = body?.payload ?? {};
  const tenantId: number = payload?.tenant_id;
  const resourceId: number = payload?.id;
  const resourceData = payload?.data ?? null;

  const swLogId = await insertWebhookLog({
    provider: "shopware",
    webhookId,
    event,
    tenantId,
    resourceId,
    timestamp,
    payload,
    raw,
    receivedAt: new Date(),
    processed: false,
    processedAt: null,
    processingError: null,
  });

  console.log(`[SW Webhook] Received ${event} for tenant ${tenantId} resource ${resourceId} (log ${swLogId})`);

  setImmediate(async () => {
    try {
      if (event === "repair_order.created" || event === "repair_order.updated" || event === "repair_order.deleted") {
        await handleRepairOrderEvent(event, tenantId, resourceId, resourceData);
      } else if (event === "vehicle.updated" || event === "vehicle.created") {
        await handleVehicleEvent(tenantId, resourceId, resourceData);
      } else if (event === "customer.updated" || event === "customer.created") {
        await handleCustomerEvent(tenantId, resourceId, resourceData);
      } else {
        console.log(`[SW Webhook] Unhandled event type: ${event}`);
      }

      await markWebhookProcessed(swLogId);
    } catch (err: any) {
      console.error("[SW Webhook] Async processing error:", err.message);
      await markWebhookFailed(swLogId, err.message);
    }
  });

  return NextResponse.json({ ok: true, received: new Date().toISOString() });
}
