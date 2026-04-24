import { getDb } from "@/lib/mongo";
import {
  getRepairOrders,
  shopWareRequest,
} from "@/lib/integrations/shopware/client";
import { computeJobHash } from "@/lib/job-index";
import type {
  ShopWareRepairOrder,
  ShopWareVehicle,
  ShopWareCustomer,
} from "@/lib/integrations/shopware/types";

// Onboarding pre-warm scope. The Shop-Ware backfill walks reverse
// chronologically in 90d (day) / 180d (night) chunks (see
// lib/integrations/backfill-pace.ts). We pre-warm the most recent
// `lookbackDays` window — by default 90, matching the day-time chunk
// size — so that the cron's very first chunk can resume from
// (today - 90d) instead of re-paginating Shop-Ware for the same
// recently-invoiced ROs the prewarm just fetched.
//
// Unlike Tekmetric (per-RO `/jobs` fan-out) or Protractor (per-invoice
// `/Invoice/{id}` fan-out), Shop-Ware's backfill cost is dominated by
// a single paginated `/repair_orders?associations=…` call per chunk;
// there is no per-RO cache to prepopulate that the cron will consult.
// So the only way to make the first cron chunk land at "cache-hit
// speed" is to do the work eagerly at onboarding and then advance the
// `shopware_backfill_progress.currentChunkEnd` cursor so the cron
// skips the prewarmed window entirely.
const PREWARM_LOOKBACK_DAYS = 90;

// Hard cap on ROs processed by the prewarm. Onboarding shouldn't burn
// the Shop-Ware quota for a high-volume shop; if we hit the cap we
// stamp the prewarm result with `capped=true` and deliberately do NOT
// advance the backfill cursor, so the regular cron will still cover
// this window.
const PREWARM_MAX_ROS = 1000;

export interface PrewarmShopWareJobsCacheOptions {
  lookbackDays?: number;
  maxRos?: number;
}

export interface PrewarmShopWareJobsCacheResult {
  shopId: number;
  tenantId: number;
  swShopId: number;
  lookbackDays: number;
  rosFetched: number;
  rosStored: number;
  jobsIndexed: number;
  jobsSkipped: number;
  vehiclesStored: number;
  customersStored: number;
  cursorAdvanced: boolean;
  cursorAdvancedTo?: string;
  errors: number;
  durationMs: number;
  capped: boolean;
  error?: string;
}

/**
 * One-shot pre-warm for Shop-Ware caches at fresh-shop onboarding —
 * the Shop-Ware analogue of `prewarmTekmetricJobsCacheForOnboarding`
 * (task #59).
 *
 * What it warms:
 *   - `shopware_repair_orders` (full RO + services + line items)
 *   - `shopware_vehicles` (when fetched as RO association)
 *   - `shopware_customers` (when fetched as RO association)
 *   - `job_index` (terminal ROs only — state==="invoice" or closed_at)
 *
 * Why this short-circuits the first backfill chunk: the SW backfill
 * cron resumes from `shopware_backfill_progress.currentChunkEnd` when
 * `logicVersion === 2`, walking reverse chronologically. After a
 * successful prewarm we set `currentChunkEnd = today - lookbackDays`
 * so the very first cron chunk starts BEFORE the prewarmed window —
 * effectively skipping the API call the cron would otherwise make for
 * data we just ingested.
 *
 * Idempotent: per-RO upserts use `contentHash` checks (same as the
 * cron) so re-running is cheap. We only advance the cursor when the
 * prewarm completed without error and didn't cap; otherwise the cron
 * starts at `today` and re-covers the window normally.
 */
export async function prewarmShopWareJobsCacheForOnboarding(
  shopId: number,
  tenantId: number,
  swShopId: number,
  options: PrewarmShopWareJobsCacheOptions = {}
): Promise<PrewarmShopWareJobsCacheResult> {
  const lookbackDays = options.lookbackDays ?? PREWARM_LOOKBACK_DAYS;
  const maxRos = options.maxRos ?? PREWARM_MAX_ROS;
  const start = Date.now();
  const db = await getDb();

  const result: PrewarmShopWareJobsCacheResult = {
    shopId,
    tenantId,
    swShopId,
    lookbackDays,
    rosFetched: 0,
    rosStored: 0,
    jobsIndexed: 0,
    jobsSkipped: 0,
    vehiclesStored: 0,
    customersStored: 0,
    cursorAdvanced: false,
    errors: 0,
    durationMs: 0,
    capped: false,
  };

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const fromDate = new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  console.log(
    `[Shop-Ware Prewarm] Shop ${shopId} (tenant ${tenantId} / sw ${swShopId}): listing ROs ${fromDate.toISOString().split("T")[0]} → ${today.toISOString().split("T")[0]} (lookback=${lookbackDays}d, cap=${maxRos})`
  );

  let ros: ShopWareRepairOrder[];
  try {
    ros = await getRepairOrders(tenantId, shopId, {
      shop_id: swShopId,
      updated_after: fromDate.toISOString(),
      associations: "services,services.labors,services.parts,customer,vehicle",
    });
  } catch (err: any) {
    result.error = err?.message || String(err);
    result.errors++;
    result.durationMs = Date.now() - start;
    console.warn(
      `[Shop-Ware Prewarm] Shop ${shopId}: list-ROs failed: ${result.error}`
    );
    await stampShopPrewarmStatus(db, shopId, result);
    return result;
  }

  // The SW list endpoint filters by `updated_after` only; clip the
  // upper bound here so we don't process ROs that were touched after
  // `today` (rare but possible if an admin clock skews).
  const filteredRos = ros.filter((ro) => {
    const updatedAt = ro.updated_at ? new Date(ro.updated_at) : null;
    return !updatedAt || updatedAt <= today;
  });

  if (filteredRos.length > maxRos) {
    result.capped = true;
    console.warn(
      `[Shop-Ware Prewarm] Shop ${shopId}: ${filteredRos.length} ROs in window > cap ${maxRos}; truncating and NOT advancing backfill cursor`
    );
    filteredRos.length = maxRos;
  }

  result.rosFetched = filteredRos.length;

  for (const ro of filteredRos) {
    let vehicle = ro.vehicle ?? null;
    let customer = ro.customer ?? null;

    // Fallback per-RO fetches when the bulk associations call
    // didn't inline vehicle/customer. Mirrors the cron's behaviour
    // (app/api/cron/shopware-backfill/route.ts).
    if (!vehicle && ro.vehicle_id) {
      try {
        vehicle = await shopWareRequest<ShopWareVehicle>(
          `/tenants/${tenantId}/vehicles/${ro.vehicle_id}`,
          {},
          shopId
        );
      } catch {
        // Non-fatal: we still cache the RO without vehicle detail.
      }
    }
    if (!customer && ro.customer_id) {
      try {
        customer = await shopWareRequest<ShopWareCustomer>(
          `/tenants/${tenantId}/customers/${ro.customer_id}`,
          {},
          shopId
        );
      } catch {
        // Non-fatal.
      }
    }

    try {
      await db.collection("shopware_repair_orders").updateOne(
        { mosShopId: shopId, roId: ro.id },
        {
          $set: {
            mosShopId: shopId,
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
      result.rosStored++;

      if (customer) {
        await db.collection("shopware_customers").updateOne(
          { mosShopId: shopId, customerId: ro.customer_id },
          {
            $set: {
              mosShopId: shopId,
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
        result.customersStored++;
      }

      if (vehicle) {
        await db.collection("shopware_vehicles").updateOne(
          { mosShopId: shopId, vehicleId: ro.vehicle_id },
          {
            $set: {
              mosShopId: shopId,
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
        result.vehiclesStored++;
      }

      // Only index terminal ROs into job_index — same predicate the
      // cron uses (app/api/cron/shopware-backfill/route.ts:210).
      const isInvoiced = ro.state === "invoice" || Boolean(ro.closed_at);
      const enrichedRo = {
        ...ro,
        vehicle: vehicle ?? ro.vehicle,
        customer: customer ?? ro.customer,
      };
      if (isInvoiced && (vehicle?.vin || ro.vehicle?.vin)) {
        const entries = extractJobEntries(shopId, enrichedRo, tenantId);
        for (const entry of entries) {
          const contentHash = computeJobHash(entry as any);
          const filter = {
            shopId,
            provider: "shopware",
            workOrderId: entry.workOrderId,
            servicePackageId: entry.servicePackageId,
          };
          const existing = await db.collection("job_index").findOne(filter);
          if (existing?.contentHash === contentHash) {
            result.jobsSkipped++;
          } else {
            await db.collection("job_index").updateOne(
              filter,
              { $set: { ...entry, contentHash } },
              { upsert: true }
            );
            result.jobsIndexed++;
          }
        }
      }
    } catch (err: any) {
      result.errors++;
      console.warn(
        `[Shop-Ware Prewarm] Shop ${shopId}: per-RO write failed for ${ro.id}: ${err?.message || err}`
      );
    }
  }

  // Advance the backfill cursor only when we processed the entire
  // window cleanly. If we capped or saw write errors, leave
  // `shopware_backfill_progress` untouched so the cron starts fresh
  // from today and re-covers the window — the prewarmed `job_index`
  // entries will short-circuit via `contentHash` checks anyway, so
  // this is just belt-and-braces for completeness.
  const cursorSafeToAdvance =
    !result.capped && result.errors === 0 && result.rosStored === filteredRos.length;

  if (cursorSafeToAdvance) {
    try {
      // The cron treats `currentChunkEnd` as the END of the next
      // chunk to process and walks backwards. Setting it to
      // `fromDate` (start of the prewarm window) means the first
      // cron chunk runs for `[fromDate - chunkDays, fromDate]`,
      // skipping the prewarmed `[fromDate, today]` window entirely.
      // `logicVersion: 2` is required for the cron to honour the
      // cursor (see app/api/cron/shopware-backfill/route.ts:320).
      await db.collection("shopware_backfill_progress").updateOne(
        { shopId },
        {
          $set: {
            shopId,
            inProgress: false,
            completed: false,
            currentChunkEnd: fromDate,
            currentCursor: fromDate.toISOString(),
            logicVersion: 2,
            prewarmCompletedAt: new Date(),
            prewarmCoveredFrom: fromDate,
            prewarmCoveredTo: today,
          },
          $setOnInsert: {
            startedAt: new Date(),
          },
        },
        { upsert: true }
      );
      result.cursorAdvanced = true;
      result.cursorAdvancedTo = fromDate.toISOString();
    } catch (err: any) {
      console.warn(
        `[Shop-Ware Prewarm] Shop ${shopId}: cursor advance failed: ${err?.message || err}`
      );
    }
  }

  result.durationMs = Date.now() - start;

  console.log(
    `[Shop-Ware Prewarm] Shop ${shopId} done: fetched=${result.rosFetched} stored=${result.rosStored} jobs=${result.jobsIndexed} skipped=${result.jobsSkipped} vehicles=${result.vehiclesStored} customers=${result.customersStored} cursorAdvanced=${result.cursorAdvanced} capped=${result.capped} errors=${result.errors} ${result.durationMs}ms`
  );

  await stampShopPrewarmStatus(db, shopId, result);
  return result;
}

// Inlined here rather than imported from app/api/cron/shopware-backfill/route.ts
// because Next.js route files aren't designed to be imported as library
// modules. This is a verbatim copy of `extractJobEntries` from that
// route — keep them in sync if the schema evolves.
function extractJobEntries(
  mosShopId: number,
  ro: ShopWareRepairOrder,
  tenantId: number
) {
  const vin = ro.vehicle?.vin?.toUpperCase() ?? null;
  const roMileage =
    (typeof (ro as any).odometer_out === "number" && (ro as any).odometer_out > 0
      ? (ro as any).odometer_out
      : null) ??
    (typeof (ro as any).odometer === "number" && (ro as any).odometer > 0
      ? (ro as any).odometer
      : null) ??
    (typeof (ro as any).odometer_in === "number" && (ro as any).odometer_in > 0
      ? (ro as any).odometer_in
      : null) ??
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

async function stampShopPrewarmStatus(
  db: any,
  shopId: number,
  result: PrewarmShopWareJobsCacheResult
): Promise<void> {
  try {
    await db.collection("shops").updateOne(
      { shopId: { $in: [shopId, String(shopId)] as any } },
      {
        $set: {
          "shopware.jobsCachePrewarm": {
            completedAt: new Date(),
            lookbackDays: result.lookbackDays,
            rosFetched: result.rosFetched,
            rosStored: result.rosStored,
            jobsIndexed: result.jobsIndexed,
            jobsSkipped: result.jobsSkipped,
            vehiclesStored: result.vehiclesStored,
            customersStored: result.customersStored,
            cursorAdvanced: result.cursorAdvanced,
            cursorAdvancedTo: result.cursorAdvancedTo ?? null,
            errors: result.errors,
            capped: result.capped,
            durationMs: result.durationMs,
            error: result.error ?? null,
          },
        },
      }
    );
  } catch (err: any) {
    console.warn(
      `[Shop-Ware Prewarm] Shop ${shopId}: failed to stamp shop status: ${err?.message || err}`
    );
  }
}
