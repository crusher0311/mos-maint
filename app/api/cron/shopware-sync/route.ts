/**
 * Shop-Ware Daily Incremental Sync
 *
 * SCHEDULE: Daily (run via daily-all cron or external scheduler)
 *
 * Catches any repair orders missed by webhooks — fetches all ROs updated since
 * lastSyncAt, upserts snapshots, indexes completed jobs, and advances lastSyncAt.
 *
 * Trigger manually: GET /api/cron/shopware-sync
 *   with: Authorization: Bearer {CRON_SECRET}
 *   or:   ?secret={CRON_SECRET}
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getRepairOrders } from "@/lib/integrations/shopware/client";
import { computeJobHash } from "@/lib/job-index";
import type { ShopWareRepairOrder } from "@/lib/integrations/shopware/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

function isAuthorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return true;
  const header = req.headers.get("authorization");
  const param = req.nextUrl.searchParams.get("secret");
  return header === `Bearer ${CRON_SECRET}` || param === CRON_SECRET;
}

function extractJobEntries(mosShopId: number, ro: ShopWareRepairOrder, tenantId: number) {
  const vin = ro.vehicle?.vin?.toUpperCase() ?? null;
  return (ro.services ?? []).map((service) => {
    const laborHours = (service.labors ?? []).reduce((s, l) => s + l.hours, 0);
    const partsAmount = (service.parts ?? []).reduce(
      (s, p) => s + ((p.sell_price_cents ?? 0) / 100) * p.quantity,
      0
    );
    const subletsAmount = (service.sublets ?? []).reduce(
      (s, sub) => s + (sub.price_cents ?? 0) / 100,
      0
    );
    const laborAmount =
      service.is_fixed_price_service && service.fixed_price_labor_total_cents != null
        ? service.fixed_price_labor_total_cents / 100
        : 0;

    return {
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
      totalAmount: laborAmount + partsAmount + subletsAmount,
      completedAt: ro.closed_at ? new Date(ro.closed_at) : undefined,
      indexedAt: new Date(),
    };
  });
}

interface ShopResult {
  shopId: number | string;
  tenantId: number;
  swShopId: number;
  rosFetched: number;
  upserted: number;
  jobsIndexed: number;
  jobsSkipped: number;
  error?: string;
}

async function syncShop(
  shopId: number | string,
  tenantId: number,
  swShopId: number,
  lastSyncAt: string | null
): Promise<ShopResult> {
  const db = await getDb();
  const mosShopId = Number(shopId);

  const fromTime = lastSyncAt
    ? new Date(lastSyncAt).toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let ros: ShopWareRepairOrder[] = [];
  try {
    ros = await getRepairOrders(tenantId, mosShopId, {
      shop_id: swShopId,
      updated_after: fromTime,
      associations: "services,services.labors,services.parts,customer,vehicle",
    });
  } catch (err: any) {
    return {
      shopId,
      tenantId,
      swShopId,
      rosFetched: 0,
      upserted: 0,
      jobsIndexed: 0,
      jobsSkipped: 0,
      error: err.message,
    };
  }

  let upserted = 0;
  let jobsIndexed = 0;
  let jobsSkipped = 0;

  for (const ro of ros) {
    await db.collection("shopware_repair_orders").updateOne(
      { mosShopId, roId: ro.id },
      {
        $set: {
          mosShopId,
          roId: ro.id,
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
        },
      },
      { upsert: true }
    );
    upserted++;

    if (ro.customer) {
      await db.collection("shopware_customers").updateOne(
        { mosShopId, customerId: ro.customer_id },
        {
          $set: {
            mosShopId,
            tenantId,
            customerId: ro.customer_id,
            firstName: ro.customer.first_name ?? null,
            lastName: ro.customer.last_name ?? null,
            name: `${ro.customer.first_name ?? ""} ${ro.customer.last_name ?? ""}`.trim(),
            email: ro.customer.email ?? null,
            phone: ro.customer.phone_number ?? ro.customer.mobile_number ?? null,
            updatedAt: ro.customer.updated_at ? new Date(ro.customer.updated_at) : null,
            syncedAt: new Date(),
          },
        },
        { upsert: true }
      );
    }

    if (ro.vehicle) {
      await db.collection("shopware_vehicles").updateOne(
        { mosShopId, vehicleId: ro.vehicle_id },
        {
          $set: {
            mosShopId,
            tenantId,
            vehicleId: ro.vehicle_id,
            vin: ro.vehicle.vin?.toUpperCase() ?? null,
            year: ro.vehicle.year ? parseInt(ro.vehicle.year, 10) : null,
            make: ro.vehicle.make ?? null,
            model: ro.vehicle.model ?? null,
            licensePlate: ro.vehicle.plate_number ?? null,
            updatedAt: ro.vehicle.updated_at ? new Date(ro.vehicle.updated_at) : null,
            syncedAt: new Date(),
          },
        },
        { upsert: true }
      );
    }

    const isInvoiced = ro.state === "invoice" || Boolean(ro.closed_at);
    if (isInvoiced && ro.vehicle?.vin) {
      const entries = extractJobEntries(mosShopId, ro, tenantId);
      for (const entry of entries) {
        const contentHash = computeJobHash(entry as any);
        const filter = {
          shopId: mosShopId,
          provider: "shopware",
          workOrderId: entry.workOrderId,
          servicePackageId: entry.servicePackageId,
        };
        const existing = await db.collection("job_index").findOne(filter);
        if (existing?.contentHash === contentHash) {
          jobsSkipped++;
        } else {
          await db.collection("job_index").updateOne(
            filter,
            { $set: { ...entry, contentHash } },
            { upsert: true }
          );
          jobsIndexed++;
        }
      }
    }
  }

  await db.collection("shops").updateOne(
    { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
    { $set: { "shopware.lastSyncAt": new Date().toISOString() } }
  );

  return { shopId, tenantId, swShopId, rosFetched: ros.length, upserted, jobsIndexed, jobsSkipped };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  console.log(`[SW Cron] Shop-Ware sync triggered at ${new Date().toISOString()}`);

  const db = await getDb();
  const swShops = await db
    .collection("shops")
    .find(
      { "shopware.tenantId": { $exists: true, $ne: null } },
      { projection: { shopId: 1, "shopware.tenantId": 1, "shopware.swShopId": 1, "shopware.lastSyncAt": 1 } }
    )
    .toArray();

  if (swShops.length === 0) {
    console.log("[SW Cron] No shops with Shop-Ware configured");
    return NextResponse.json({ ok: true, shopsFound: 0, results: [], duration: `${Date.now() - startTime}ms` });
  }

  console.log(`[SW Cron] Found ${swShops.length} Shop-Ware shop(s)`);

  const results: ShopResult[] = [];

  for (const shop of swShops) {
    const { tenantId, swShopId, lastSyncAt } = shop.shopware;
    console.log(
      `[SW Cron] Syncing shop ${shop.shopId} (tenant ${tenantId} / sw-shop ${swShopId}) since ${lastSyncAt ?? "24h ago"}`
    );

    const result = await syncShop(shop.shopId, tenantId, swShopId, lastSyncAt ?? null);
    results.push(result);

    if (result.error) {
      console.error(`[SW Cron] Shop ${shop.shopId} error: ${result.error}`);
    } else {
      console.log(
        `[SW Cron] Shop ${shop.shopId}: ${result.rosFetched} ROs fetched, ${result.upserted} upserted, ${result.jobsIndexed} jobs indexed (${result.jobsSkipped} unchanged)`
      );
    }
  }

  const duration = Date.now() - startTime;
  const totalRos = results.reduce((s, r) => s + r.rosFetched, 0);
  const totalJobs = results.reduce((s, r) => s + r.jobsIndexed, 0);
  const errors = results.filter((r) => r.error).length;

  console.log(
    `[SW Cron] Completed in ${duration}ms — ${swShops.length} shops, ${totalRos} ROs, ${totalJobs} jobs indexed, ${errors} errors`
  );

  return NextResponse.json({
    ok: true,
    shopsFound: swShops.length,
    duration: `${duration}ms`,
    totals: { ros: totalRos, jobsIndexed: totalJobs, errors },
    results,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
