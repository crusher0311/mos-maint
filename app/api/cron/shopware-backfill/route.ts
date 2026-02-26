import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  getRepairOrders,
} from "@/lib/integrations/shopware/client";
import { computeJobHash } from "@/lib/job-index";
import type { ShopWareRepairOrder } from "@/lib/integrations/shopware/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;
const CHUNK_DAYS = 90;
const MAX_CHUNKS_PER_RUN = 4;

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
      rosStored++;

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
        customersStored++;
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
        vehiclesStored++;
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

    let progress = await db.collection("shopware_backfill_progress").findOne({ shopId: mosShopId });

    if (progress?.completed) {
      console.log(`[SW Backfill] Shop ${mosShopId} already completed, skipping`);
      allResults.push({ shopId: mosShopId, status: "already_completed" });
      continue;
    }

    if (progress?.inProgress) {
      const lastActiveAt = progress.lastChunkAt || progress.startedAt;
      if (lastActiveAt) {
        const progressAge = Date.now() - new Date(lastActiveAt).getTime();
        if (progressAge < 10 * 60 * 1000) {
          console.log(`[SW Backfill] Shop ${mosShopId} already in progress, skipping`);
          allResults.push({ shopId: mosShopId, status: "in_progress" });
          continue;
        }
      }
    }

    const fiveYearsAgo = new Date();
    fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);

    const currentCursor = progress?.currentCursor
      ? new Date(progress.currentCursor)
      : fiveYearsAgo;

    const now = new Date();

    await db.collection("shopware_backfill_progress").updateOne(
      { shopId: mosShopId },
      {
        $set: {
          shopId: mosShopId,
          inProgress: true,
          startedAt: progress?.startedAt || new Date(),
          lastChunkAt: new Date(),
        },
      },
      { upsert: true }
    );

    console.log(
      `[SW Backfill] Shop ${mosShopId} (tenant ${tenantId}): starting from ${currentCursor.toISOString()}`
    );

    let cursor = new Date(currentCursor);
    let totalRos = 0;
    let totalJobs = 0;
    let totalVehicles = 0;
    let totalCustomers = 0;
    let chunksProcessed = 0;
    let chunkError: string | undefined;

    for (let i = 0; i < MAX_CHUNKS_PER_RUN && cursor < now; i++) {
      const chunkEnd = new Date(cursor.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000);
      const effectiveEnd = chunkEnd > now ? now : chunkEnd;

      console.log(
        `[SW Backfill] Shop ${mosShopId}: chunk ${i + 1} — ${cursor.toISOString()} to ${effectiveEnd.toISOString()}`
      );

      const result = await backfillShopChunk(mosShopId, tenantId, swShopId, cursor, effectiveEnd);

      totalRos += result.rosStored;
      totalJobs += result.jobsIndexed;
      totalVehicles += result.vehiclesStored;
      totalCustomers += result.customersStored;
      chunksProcessed++;

      if (result.error) {
        chunkError = result.error;
        console.error(`[SW Backfill] Shop ${mosShopId} chunk error: ${result.error}`);
        break;
      }

      console.log(
        `[SW Backfill] Shop ${mosShopId}: chunk done — ${result.rosFetched} ROs, ${result.jobsIndexed} jobs, ${result.vehiclesStored} vehicles, ${result.customersStored} customers`
      );

      cursor = effectiveEnd;

      await db.collection("shopware_backfill_progress").updateOne(
        { shopId: mosShopId },
        {
          $set: {
            currentCursor: cursor.toISOString(),
            lastChunkAt: new Date(),
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

    const isComplete = cursor >= now && !chunkError;

    await db.collection("shopware_backfill_progress").updateOne(
      { shopId: mosShopId },
      {
        $set: {
          inProgress: false,
          completed: isComplete,
          completedAt: isComplete ? new Date() : undefined,
          currentCursor: cursor.toISOString(),
          lastChunkAt: new Date(),
        },
      }
    );

    if (isComplete) {
      const finalProgress = await db.collection("shopware_backfill_progress").findOne({ shopId: mosShopId });
      await db.collection("shops").updateOne(
        { shopId: { $in: [mosShopId, String(mosShopId)] } },
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
