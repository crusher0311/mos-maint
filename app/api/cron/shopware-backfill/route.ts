import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  getRepairOrders,
  shopWareRequest,
  runWithShopwareBackoffTracking,
} from "@/lib/integrations/shopware/client";
import { computeJobHash } from "@/lib/job-index";
import type { ShopWareRepairOrder, ShopWareVehicle, ShopWareCustomer } from "@/lib/integrations/shopware/types";
import { getPaceConfig, describePace, getBackfillYears, reopenCompletedShopsForHorizon } from "@/lib/integrations/backfill-pace";
import { prepareQuietWindowGate, applyQuietWindowGate } from "@/lib/data/repositories/activity-profiles";
import {
  findShopwareBackfillProgress,
  updateShopwareBackfillProgress,
} from "@/lib/data/repositories/shopware-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;
const STALE_LOCK_MS = 3 * 60 * 1000; // shrunk from 10min so a crashed run unblocks fast
// Per-chunk metrics rolling window. Mirrors the Tekmetric/Protractor backfill
// caps so the admin sync-health view can compute median/p95 chunk duration
// per shop without grepping cron logs. 25 entries keeps the progress doc
// small (~5KB) while leaving headroom to spot a regression.
const RECENT_CHUNK_METRICS_LIMIT = 25;

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

type ShopwareChunkMetrics = {
  durationMs: number;
  roCount: number;
  vehiclesCacheHits: number;
  vehiclesCacheMisses: number;
  customersCacheHits: number;
  customersCacheMisses: number;
  backoffDeltaMs: number;
};

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
  metrics: ShopwareChunkMetrics;
  error?: string;
}> {
  const db = await getDb();
  const mosShopId = shopId;

  // Per-chunk speed metrics. Cache-hit semantics: a "hit" = the RO list
  // response already included the vehicle/customer association (no extra
  // API call), a "miss" = we had to fall back to a separate
  // /vehicles/{id} or /customers/{id} fetch. Mirrors the Tekmetric backfill
  // shape so the admin view's `summarizeChunkMetrics` helper can render
  // both providers without a per-provider branch. The backoff figure is
  // sourced from a per-chunk AsyncLocalStorage counter (see
  // `runWithShopwareBackoffTracking` in shopware/client.ts) so concurrent
  // chunks don't leak rate-limit waits into each other's metric.
  // Task #460: capture write fan-out + record into backfill_chunk_metrics.
  const { withChunkWriteCounters } = await import("@/lib/backfill-metrics/write-counters");
  const { recordChunkMetric } = await import("@/lib/backfill-metrics/chunk-metrics");
  return withChunkWriteCounters(async (chunkWriteCounters) => {
  const _metricStartedAt = Date.now();
  let _metricOutcome: "ok" | "error" | "deferred" | "complete" | "empty" = "ok";
  let _metricRos = 0;
  let _metricBackoffMs = 0;
  try {
  const _innerResult = await runWithShopwareBackoffTracking(async (chunkBackoffCounter) => {
  const chunkStartedAt = Date.now();
  let vehiclesCacheHits = 0;
  let vehiclesCacheMisses = 0;
  let customersCacheHits = 0;
  let customersCacheMisses = 0;

  let rosFetched = 0;
  let rosStored = 0;
  let jobsIndexed = 0;
  let jobsSkipped = 0;
  let vehiclesStored = 0;
  let customersStored = 0;

  const buildMetrics = (): ShopwareChunkMetrics => ({
    durationMs: Date.now() - chunkStartedAt,
    roCount: rosFetched,
    vehiclesCacheHits,
    vehiclesCacheMisses,
    customersCacheHits,
    customersCacheMisses,
    backoffDeltaMs: chunkBackoffCounter.ms,
  });

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

      if (ro.vehicle_id) {
        if (vehicle) {
          vehiclesCacheHits++;
        } else {
          vehiclesCacheMisses++;
          try {
            vehicle = await shopWareRequest<ShopWareVehicle>(
              `/tenants/${tenantId}/vehicles/${ro.vehicle_id}`,
              {},
              mosShopId
            );
          } catch {}
        }
      }
      if (ro.customer_id) {
        if (customer) {
          customersCacheHits++;
        } else {
          customersCacheMisses++;
          try {
            customer = await shopWareRequest<ShopWareCustomer>(
              `/tenants/${tenantId}/customers/${ro.customer_id}`,
              {},
              mosShopId
            );
          } catch {}
        }
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
      metrics: buildMetrics(),
      error: err.message,
    };
  }

  return {
    rosFetched,
    rosStored,
    jobsIndexed,
    jobsSkipped,
    vehiclesStored,
    customersStored,
    metrics: buildMetrics(),
    _chunkBackoffMs: chunkBackoffCounter.ms,
  } as any;
  });
  _metricRos = _innerResult.rosFetched ?? 0;
  _metricBackoffMs = Math.round((_innerResult as any)._chunkBackoffMs ?? 0);
  _metricOutcome = _innerResult.error ? "error" : "ok";
  // Strip private metric field from the public return shape.
  const { _chunkBackoffMs: _omit, ...publicResult } = _innerResult as any;
  return publicResult;
  } catch (err) {
    _metricOutcome = "error";
    throw err;
  } finally {
    await recordChunkMetric({
      provider: "shopware",
      shopId,
      chunkStartedAt: _metricStartedAt,
      rosProcessed: _metricRos,
      outcome: _metricOutcome,
      backoffMs: _metricBackoffMs,
      counters: chunkWriteCounters,
    });
  }
  });
}

// Builds the per-chunk metrics object persisted on
// `shopware_backfill_progress`. Mirrors the Tekmetric/Protractor backfill
// shape so the `summarizeChunkMetrics` helper in the admin sync-health
// route can render all three providers without a per-provider branch. The
// jobs* slot is unused for Shop-Ware (no per-RO jobs cache exists), the
// vehicles* and customers* slots track inline-association hit rates.
function buildShopwareChunkMetrics(input: {
  now: Date;
  metrics: ShopwareChunkMetrics;
  chunkStart: Date;
  chunkEnd: Date;
  nextChunkEnd: Date;
  advanceMode: string;
  chunkHadError: boolean;
}) {
  const vehTotal = input.metrics.vehiclesCacheHits + input.metrics.vehiclesCacheMisses;
  const custTotal = input.metrics.customersCacheHits + input.metrics.customersCacheMisses;
  return {
    at: input.now,
    durationMs: input.metrics.durationMs,
    roCount: input.metrics.roCount,
    chunkStart: input.chunkStart,
    chunkEnd: input.chunkEnd,
    nextChunkEnd: input.nextChunkEnd,
    advanceMode: input.advanceMode,
    jobsCacheHits: 0,
    jobsCacheMisses: 0,
    jobsCacheHitRate: null,
    vehiclesCacheHits: input.metrics.vehiclesCacheHits,
    vehiclesCacheMisses: input.metrics.vehiclesCacheMisses,
    vehiclesCacheHitRate:
      vehTotal > 0
        ? Number((input.metrics.vehiclesCacheHits / vehTotal).toFixed(4))
        : null,
    customersCacheHits: input.metrics.customersCacheHits,
    customersCacheMisses: input.metrics.customersCacheMisses,
    customersCacheHitRate:
      custTotal > 0
        ? Number((input.metrics.customersCacheHits / custTotal).toFixed(4))
        : null,
    backoff429Ms: Math.round(input.metrics.backoffDeltaMs),
    chunkHadError: input.chunkHadError,
    hitPageCap: false,
    perRoExceptions: 0,
  };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const db = await getDb();

  const targetShopId = req.nextUrl.searchParams.get("shopId");
  const shopQuery: any = {
    "shopware.tenantId": { $exists: true, $ne: null },
    // Skip shops flagged as sandbox / non-prod credentials (e.g. shop 77 uses
    // separate Shop-Ware sandbox auth and returns 404 against the prod tenant).
    // Targeted `?shopId=` calls bypass this so on-call can still force-run.
    "shopware.backfillDisabled": { $ne: true },
  };
  if (targetShopId) {
    shopQuery.shopId = { $in: [Number(targetShopId), String(targetShopId)] };
    delete shopQuery["shopware.backfillDisabled"];
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

  // Horizon-raise reopen: if the operator raised BACKFILL_HORIZON_YEARS, clear
  // the completion flag on shops that still have deeper history to walk so the
  // `progress.completed` skip below no longer short-circuits them and they
  // resume from their parked cursor. No-op until the horizon is raised.
  await reopenCompletedShopsForHorizon({
    db,
    progressCollection: "shopware_backfill_progress",
    providerLabel: "SW Backfill",
    eligibleShopIds: swShops
      .map((s: any) => Number(s.shopId))
      .filter((n: number) => Number.isFinite(n)),
  });

  // Smart per-shop quiet-window gate (task #662). OFF by default: no DB read,
  // no logging, no behavior change. Built once per tick.
  const quietGate = await prepareQuietWindowGate(
    swShops.map((s: any) => Number(s.shopId)),
  );

  const allResults: any[] = [];

  for (const shop of swShops) {
    const { tenantId, swShopId } = shop.shopware;
    const mosShopId = Number(shop.shopId);

    const shopDoc = await db.collection("shops").findOne({ shopId: { $in: [mosShopId, String(mosShopId)] as any } });
    const pace = getPaceConfig("shopware", shopDoc?.timezone, new Date());

    let progress = (await findShopwareBackfillProgress(mosShopId)) as any;

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

    // Quiet-window gate: defer this shop when it's outside its own quiet window
    // (enforce mode only; observe just logs; off is a no-op). Placed after the
    // already-completed / in-progress short-circuits so those still report their
    // real status, and before any chunk work runs.
    if (applyQuietWindowGate(quietGate, mosShopId, "shopware").shouldSkip) {
      allResults.push({ shopId: mosShopId, status: "deferred_quiet_window" });
      continue;
    }

    const yearsToBackfill = getBackfillYears();
    const oldestDate = new Date();
    oldestDate.setFullYear(oldestDate.getFullYear() - yearsToBackfill);
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

    await updateShopwareBackfillProgress(
      mosShopId,
      {
        set: {
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
      `[SW Backfill] Shop ${mosShopId} (tenant ${tenantId}): reverse from ${chunkEndCursor.toISOString().split("T")[0]} horizon=${yearsToBackfill}y ${describePace(pace)}`
    );

    let cursor = new Date(chunkEndCursor);
    let totalRos = 0;
    let totalJobs = 0;
    let totalVehicles = 0;
    let totalCustomers = 0;
    let chunksProcessed = 0;
    let chunkError: string | undefined;
    // Mutable copy of recentChunkMetrics so we can persist after every chunk
    // without re-reading the progress doc each iteration.
    let recentChunkMetrics: any[] = Array.isArray(progress?.recentChunkMetrics)
      ? [...progress.recentChunkMetrics]
      : [];

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

      // Build the chunk metric record for this iteration. We persist on both
      // success and error paths so an admin can see chunks that 429'd hard
      // alongside healthy ones.
      const chunkMetric = buildShopwareChunkMetrics({
        now: new Date(),
        metrics: result.metrics,
        chunkStart: effectiveStart,
        chunkEnd: cursor,
        nextChunkEnd: result.error ? cursor : effectiveStart,
        advanceMode: result.error ? "HOLD (chunk error)" : "FULL",
        chunkHadError: !!result.error,
      });
      recentChunkMetrics = [chunkMetric, ...recentChunkMetrics].slice(
        0,
        RECENT_CHUNK_METRICS_LIMIT,
      );

      console.log(
        `[SW Backfill] Shop ${mosShopId}: chunk metrics ` +
          `duration=${chunkMetric.durationMs}ms ros=${result.metrics.roCount} ` +
          `vehiclesCache=${result.metrics.vehiclesCacheHits}/${result.metrics.vehiclesCacheHits + result.metrics.vehiclesCacheMisses} ` +
          `customersCache=${result.metrics.customersCacheHits}/${result.metrics.customersCacheHits + result.metrics.customersCacheMisses} ` +
          `backoff=${chunkMetric.backoff429Ms}ms`,
      );

      if (result.error) {
        chunkError = result.error;
        console.error(`[SW Backfill] Shop ${mosShopId} chunk error (HOLDING cursor): ${result.error}`);
        // Persist metrics even on error so the admin view captures rate-limit
        // hits, then break (cursor not advanced — next run retries chunk).
        await updateShopwareBackfillProgress(mosShopId, {
          set: {
            lastChunkAt: new Date(),
            lastRunAt: new Date(),
            lastChunkMetrics: chunkMetric,
            recentChunkMetrics,
          },
        });
        break;
      }

      console.log(
        `[SW Backfill] Shop ${mosShopId}: chunk done — ${result.rosFetched} ROs, ${result.jobsIndexed} jobs, ${result.vehiclesStored} vehicles, ${result.customersStored} customers`
      );

      const previousChunkEnd = cursor;
      cursor = effectiveStart;

      await updateShopwareBackfillProgress(mosShopId, {
        set: {
          currentChunkEnd: cursor,
          currentCursor: cursor.toISOString(),
          previousChunkEnd,
          lastChunkAt: new Date(),
          lastRunAt: new Date(),
          lastCursorMoveAt: new Date(),
          lastError: null,
          lastErrorAt: null,
          lastChunkMetrics: chunkMetric,
          recentChunkMetrics,
        },
        inc: {
          totalRosProcessed: result.rosStored,
          totalJobsIndexed: result.jobsIndexed,
          totalVehiclesProcessed: result.vehiclesStored,
          totalCustomersProcessed: result.customersStored,
        },
      });
    }

    const isComplete = cursor <= oldestDate && !chunkError;

    await updateShopwareBackfillProgress(mosShopId, {
      set: {
        inProgress: false,
        completed: isComplete,
        completedAt: isComplete ? new Date() : undefined,
        currentChunkEnd: cursor,
        currentCursor: cursor.toISOString(),
        lastChunkAt: new Date(),
        lastRunAt: new Date(),
        ...(chunkError ? { lastError: chunkError, lastErrorAt: new Date() } : {}),
      },
    });

    if (isComplete) {
      const finalProgress = (await findShopwareBackfillProgress(mosShopId)) as any;
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
