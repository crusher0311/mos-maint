import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  getRepairOrders,
  shopWareRequest,
} from "@/lib/integrations/shopware/client";
import { computeJobHash } from "@/lib/job-index";
import type { ShopWareRepairOrder, ShopWareVehicle, ShopWareCustomer } from "@/lib/integrations/shopware/types";
import { getPaceConfig, describePace } from "@/lib/integrations/backfill-pace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;
const STALE_LOCK_MS = 3 * 60 * 1000; // shrunk from 10min so a crashed run unblocks fast
const YEARS_TO_BACKFILL = 5;

function isAuthorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return true;
  const header = req.headers.get("authorization");
  const param = req.nextUrl.searchParams.get("secret");
  return header === `Bearer ${CRON_SECRET}` || param === CRON_SECRET;
}

function extractJobEntries(mosShopId: number, ro: ShopWareRepairOrder, tenantId: number) {
  const vin = ro.vehicle?.vin?.toUpperCase() ?? null;
  const roMileage =
    (typeof (ro as any).odometer_out === "number" && (ro as any).odometer_out > 0 ? (ro as any).odometer_out : null) ??
    (typeof (ro as any).odometer === "number" && (ro as any).odometer > 0 ? (ro as any).odometer : null) ??
    (typeof (ro as any).odometer_in === "number" && (ro as any).odometer_in > 0 ? (ro as any).odometer_in : null) ??
    null;
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
      mileage: roMileage,
      indexedAt: new Date(),
    };
  });
}

async function backfillShopChunk(
  shopId: number,
  tenantId: number,
  swShopId: number,
  fromDate: Date,
  toDate: Date
): Promise<{
  rosFetched: number;
  rosStored: number;
  jobsIndexed: number;
  jobsSkipped: number;
  vehiclesStored: number;
  customersStored: number;
  error?: string;
}> {
  const db = await getDb();
  const mosShopId = shopId;

  let rosFetched = 0;
  let rosStored = 0;
  let jobsIndexed = 0;
  let jobsSkipped = 0;
  let vehiclesStored = 0;
  let customersStored = 0;

  try {
    const ros = await getRepairOrders(tenantId, mosShopId, {
      shop_id: swShopId,
      updated_after: fromDate.toISOString(),
      associations: "services,services.labors,services.parts,customer,vehicle",
    });

    const filteredRos = ros.filter((ro) => {
      const updatedAt = ro.updated_at ? new Date(ro.updated_at) : null;
      return !updatedAt || updatedAt <= toDate;
    });

    rosFetched = filteredRos.length;

    for (const ro of filteredRos) {
      let vehicle = ro.vehicle ?? null;
      let customer = ro.customer ?? null;

      if (!vehicle && ro.vehicle_id) {
        try {
          vehicle = await shopWareRequest<ShopWareVehicle>(
            `/tenants/${tenantId}/vehicles/${ro.vehicle_id}`,
            {},
            mosShopId
          );
        } catch {}
      }
      if (!customer && ro.customer_id) {
        try {
          customer = await shopWareRequest<ShopWareCustomer>(
            `/tenants/${tenantId}/customers/${ro.customer_id}`,
            {},
            mosShopId
          );
        } catch {}
      }

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
            vin: vehicle?.vin?.toUpperCase() ?? null,
            customerId: ro.customer_id,
            vehicleId: ro.vehicle_id,
            customerName: customer
              ? `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim()
              : null,
            vehicleYear: vehicle?.year ? parseInt(String(vehicle.year), 10) : null,
            vehicleMake: vehicle?.make ?? null,
            vehicleModel: vehicle?.model ?? null,
            odometer: ro.odometer ?? null,
            serviceCount: ro.services?.length ?? 0,
            createdAt: ro.created_at ? new Date(ro.created_at) : null,
            updatedAt: ro.updated_at ? new Date(ro.updated_at) : null,
            closedAt: ro.closed_at ? new Date(ro.closed_at) : null,
            raw: { ...ro, vehicle, customer },
            syncedAt: new Date(),
          },
        },
        { upsert: true }
      );
      rosStored++;

      if (customer) {
        await db.collection("shopware_customers").updateOne(
          { mosShopId, customerId: ro.customer_id },
          {
            $set: {
              mosShopId,
              tenantId,
              customerId: ro.customer_id,
              firstName: customer.first_name ?? null,
              lastName: customer.last_name ?? null,
              name: `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim(),
              email: customer.email ?? null,
              phone: customer.phone_number ?? customer.mobile_number ?? null,
              updatedAt: customer.updated_at ? new Date(customer.updated_at) : null,
              syncedAt: new Date(),
            },
          },
          { upsert: true }
        );
        customersStored++;
      }

      if (vehicle) {
        await db.collection("shopware_vehicles").updateOne(
          { mosShopId, vehicleId: ro.vehicle_id },
          {
            $set: {
              mosShopId,
              tenantId,
              vehicleId: ro.vehicle_id,
              vin: vehicle.vin?.toUpperCase() ?? null,
              year: vehicle.year ? parseInt(String(vehicle.year), 10) : null,
              make: vehicle.make ?? null,
              model: vehicle.model ?? null,
              licensePlate: vehicle.plate_number ?? null,
              updatedAt: vehicle.updated_at ? new Date(vehicle.updated_at) : null,
              syncedAt: new Date(),
            },
          },
          { upsert: true }
        );
        vehiclesStored++;
      }

      const isInvoiced = ro.state === "invoice" || Boolean(ro.closed_at);
      const enrichedRo = { ...ro, vehicle: vehicle ?? ro.vehicle, customer: customer ?? ro.customer };
      if (isInvoiced && (vehicle?.vin || ro.vehicle?.vin)) {
        const entries = extractJobEntries(mosShopId, enrichedRo, tenantId);
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
  } catch (err: any) {
    return {
      rosFetched,
      rosStored,
      jobsIndexed,
      jobsSkipped,
      vehiclesStored,
      customersStored,
      error: err.message,
    };
  }

  return { rosFetched, rosStored, jobsIndexed, jobsSkipped, vehiclesStored, customersStored };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const db = await getDb();

  const targetShopId = req.nextUrl.searchParams.get("shopId");
  const shopQuery: any = { "shopware.tenantId": { $exists: true, $ne: null } };
  if (targetShopId) {
    shopQuery.shopId = { $in: [Number(targetShopId), String(targetShopId)] };
  }

  const swShops = await db
    .collection("shops")
    .find(shopQuery, {
      projection: {
        shopId: 1,
        name: 1,
        "shopware.tenantId": 1,
        "shopware.swShopId": 1,
      },
    })
    .toArray();

  if (swShops.length === 0) {
    return NextResponse.json({ ok: true, message: "No Shop-Ware shops found", results: [] });
  }

  const allResults: any[] = [];

  for (const shop of swShops) {
    const { tenantId, swShopId } = shop.shopware;
    const mosShopId = Number(shop.shopId);

    const shopDoc = await db.collection("shops").findOne({ shopId: { $in: [mosShopId, String(mosShopId)] as any } });
    const pace = getPaceConfig("shopware", shopDoc?.timezone, new Date());

    let progress = await db.collection("shopware_backfill_progress").findOne({ shopId: mosShopId });

    if (progress?.completed && progress?.logicVersion === 2) {
      console.log(`[SW Backfill] Shop ${mosShopId} already completed, skipping`);
      allResults.push({ shopId: mosShopId, status: "already_completed" });
      continue;
    }

    if (progress?.inProgress) {
      const lastActiveAt = progress.lastChunkAt || progress.startedAt;
      if (lastActiveAt) {
        const progressAge = Date.now() - new Date(lastActiveAt).getTime();
        if (progressAge < STALE_LOCK_MS) {
          console.log(`[SW Backfill] Shop ${mosShopId} already in progress (${Math.round(progressAge/1000)}s ago), skipping`);
          allResults.push({ shopId: mosShopId, status: "in_progress" });
          continue;
        }
      }
    }

    const oldestDate = new Date();
    oldestDate.setFullYear(oldestDate.getFullYear() - YEARS_TO_BACKFILL);
    oldestDate.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(23, 59, 59, 999);

    // REVERSE CHRONOLOGICAL: cursor = chunkEnd, walking backwards.
    // currentCursor here represents the END of the next chunk to process.
    // Fresh start (or upgrading from old forward-walking logic v1) -> begin at today.
    const isFreshOrUpgrading = !progress?.currentChunkEnd || progress?.logicVersion !== 2;
    const chunkEndCursor: Date = isFreshOrUpgrading
      ? today
      : new Date(progress.currentChunkEnd);

    if (isFreshOrUpgrading) {
      console.log(`[SW Backfill] Shop ${mosShopId}: starting fresh in REVERSE mode (was logicVersion=${progress?.logicVersion ?? "none"})`);
    }

    await db.collection("shopware_backfill_progress").updateOne(
      { shopId: mosShopId },
      {
        $set: {
          shopId: mosShopId,
          inProgress: true,
          startedAt: progress?.startedAt || new Date(),
          lastChunkAt: new Date(),
          lastRunAt: new Date(),
          logicVersion: 2,
          ...(isFreshOrUpgrading ? { currentChunkEnd: chunkEndCursor, completed: false } : {}),
        },
      },
      { upsert: true }
    );

    console.log(
      `[SW Backfill] Shop ${mosShopId} (tenant ${tenantId}): reverse from ${chunkEndCursor.toISOString().split("T")[0]} ${describePace(pace)}`
    );

    let cursor = new Date(chunkEndCursor);
    let totalRos = 0;
    let totalJobs = 0;
    let totalVehicles = 0;
    let totalCustomers = 0;
    let chunksProcessed = 0;
    let chunkError: string | undefined;

    for (let i = 0; i < pace.maxChunksPerRun && cursor > oldestDate; i++) {
      const chunkStart = new Date(cursor.getTime() - pace.chunkDays * 24 * 60 * 60 * 1000);
      const effectiveStart = chunkStart < oldestDate ? oldestDate : chunkStart;

      console.log(
        `[SW Backfill] Shop ${mosShopId}: chunk ${i + 1} — ${effectiveStart.toISOString().split("T")[0]} to ${cursor.toISOString().split("T")[0]}`
      );

      const result = await backfillShopChunk(mosShopId, tenantId, swShopId, effectiveStart, cursor);

      totalRos += result.rosStored;
      totalJobs += result.jobsIndexed;
      totalVehicles += result.vehiclesStored;
      totalCustomers += result.customersStored;
      chunksProcessed++;

      if (result.error) {
        chunkError = result.error;
        console.error(`[SW Backfill] Shop ${mosShopId} chunk error (HOLDING cursor): ${result.error}`);
        // Do NOT advance cursor on error — next run will retry the same chunk.
        break;
      }

      console.log(
        `[SW Backfill] Shop ${mosShopId}: chunk done — ${result.rosFetched} ROs, ${result.jobsIndexed} jobs, ${result.vehiclesStored} vehicles, ${result.customersStored} customers`
      );

      const previousChunkEnd = cursor;
      cursor = effectiveStart;

      await db.collection("shopware_backfill_progress").updateOne(
        { shopId: mosShopId },
        {
          $set: {
            currentChunkEnd: cursor,
            currentCursor: cursor.toISOString(),
            previousChunkEnd,
            lastChunkAt: new Date(),
            lastRunAt: new Date(),
            lastCursorMoveAt: new Date(),
            lastError: null,
            lastErrorAt: null,
          },
          $inc: {
            totalRosProcessed: result.rosStored,
            totalJobsIndexed: result.jobsIndexed,
            totalVehiclesProcessed: result.vehiclesStored,
            totalCustomersProcessed: result.customersStored,
          },
        }
      );
    }

    const isComplete = cursor <= oldestDate && !chunkError;

    await db.collection("shopware_backfill_progress").updateOne(
      { shopId: mosShopId },
      {
        $set: {
          inProgress: false,
          completed: isComplete,
          completedAt: isComplete ? new Date() : undefined,
          currentChunkEnd: cursor,
          currentCursor: cursor.toISOString(),
          lastChunkAt: new Date(),
          lastRunAt: new Date(),
          ...(chunkError ? { lastError: chunkError, lastErrorAt: new Date() } : {}),
        },
      }
    );

    if (isComplete) {
      const finalProgress = await db.collection("shopware_backfill_progress").findOne({ shopId: mosShopId });
      await db.collection("shops").updateOne(
        { shopId: { $in: [mosShopId, String(mosShopId)] as any } },
        {
          $set: {
            backfill: {
              status: "completed",
              source: "shopware",
              completedAt: new Date(),
              totalJobsIndexed: finalProgress?.totalJobsIndexed || totalJobs,
            },
          },
        }
      );
    }

    allResults.push({
      shopId: mosShopId,
      status: isComplete ? "completed" : chunkError ? "error" : "in_progress",
      chunksProcessed,
      totalRos,
      totalJobs,
      totalVehicles,
      totalCustomers,
      error: chunkError,
      cursor: cursor.toISOString(),
      pace: { isOffHours: pace.isOffHours, chunkDays: pace.chunkDays, maxChunksPerRun: pace.maxChunksPerRun },
    });
  }

  const duration = Date.now() - startTime;
  console.log(`[SW Backfill] Done in ${duration}ms`);

  return NextResponse.json({
    ok: true,
    duration: `${duration}ms`,
    results: allResults,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
