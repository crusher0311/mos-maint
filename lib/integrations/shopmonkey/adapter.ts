import { getDb } from "@/lib/mongo";
import type {
  IIntegrationAdapter,
  IntegrationConfig,
  Result,
  NormalizedVehicle,
  NormalizedWorkOrder,
  CannedJob,
  WorkOrderQuery,
  BackfillOptions,
  BackfillResult,
  SyncResult,
} from "@/lib/integrations/core/types";
import {
  isConfigured,
  getCredentials,
} from "./auth";
import {
  testConnection as testShopmonkeyConnection,
  getVehicle as getShopmonkeyVehicle,
  searchVehiclesByVin,
  getOrder,
  getOrders,
  getOrdersPaged,
  getOrderServiceItems,
  getServiceItems,
  getCannedServices,
} from "./client";
import { transformVehicle, transformOrder, transformCannedService } from "./transform";
import type { ShopmonkeyOrder, ShopmonkeyServiceItem } from "./types";
import { resolveShopDistanceUnit } from "@/lib/shop-distance-unit";
import { PROGRESS_COLLECTION } from "./inflight-lock";
import { NormalizedIngestionService } from "@/lib/integrations/core/normalized-ingestion";

/**
 * Resolve the normalized odometer unit for a Shopmonkey shop via the central
 * distance-unit policy (lib/shop-distance-unit.ts). Shopmonkey serves the US
 * (miles); the policy derives the unit from the shop's known country and falls
 * back to miles when the country isn't backfilled — so a stray "kilometers"
 * preference can't bleed into normalized mileage and inflate VHI scores.
 */
async function getMileageUnit(shopId: number): Promise<"miles" | "kilometers"> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
    {
      projection: {
        integrationProvider: 1,
        smsProvider: 1,
        "preferences.distanceUnit": 1,
        "preferences.distanceUnitSource": 1,
        geo: 1,
      },
    },
  );
  return resolveShopDistanceUnit(shop as any);
}

export class ShopmonkeyAdapter implements IIntegrationAdapter {
  provider = "shopmonkey" as const;
  priority = 10;

  async isConfigured(shopId: number): Promise<boolean> {
    return isConfigured(shopId);
  }

  async getConfig(shopId: number): Promise<IntegrationConfig | null> {
    const creds = await getCredentials(shopId);
    if (!creds) return null;

    return {
      provider: "shopmonkey",
      configured: true,
      shopId,
      credentials: {
        locationId: creds.locationId,
        companyId: creds.companyId,
        hasApiKey: true,
      },
    };
  }

  async testConnection(shopId: number): Promise<Result<{ message: string }>> {
    const creds = await getCredentials(shopId);
    if (!creds) return { ok: false, error: "Shopmonkey not configured for this shop" };

    const result = await testShopmonkeyConnection(shopId);
    if (!result.ok) return { ok: false, error: result.error ?? "Connection test failed" };
    return { ok: true, data: { message: "Shopmonkey connection successful" } };
  }

  async getVehicle(shopId: number, vehicleId: string): Promise<Result<NormalizedVehicle>> {
    if (!(await isConfigured(shopId))) return { ok: false, error: "Shopmonkey not configured" };

    try {
      const [vehicle, mileageUnit] = await Promise.all([
        getShopmonkeyVehicle(shopId, vehicleId),
        getMileageUnit(shopId),
      ]);
      return { ok: true, data: transformVehicle(vehicle, { mileageUnit }) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? "Vehicle not found" };
    }
  }

  async getVehicleByVin(shopId: number, vin: string): Promise<Result<NormalizedVehicle>> {
    if (!(await isConfigured(shopId))) return { ok: false, error: "Shopmonkey not configured" };

    try {
      const [matches, mileageUnit] = await Promise.all([
        searchVehiclesByVin(shopId, vin),
        getMileageUnit(shopId),
      ]);
      if (!matches.length) return { ok: false, error: "Vehicle not found" };
      return { ok: true, data: transformVehicle(matches[0], { mileageUnit }) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? "Search failed" };
    }
  }

  async getWorkOrder(shopId: number, workOrderId: string): Promise<Result<NormalizedWorkOrder>> {
    if (!(await isConfigured(shopId))) return { ok: false, error: "Shopmonkey not configured" };

    try {
      const [order, mileageUnit] = await Promise.all([
        getOrder(shopId, workOrderId),
        getMileageUnit(shopId),
      ]);
      // Shopmonkey orders don't embed line items; fetch them separately.
      const serviceItems = await getOrderServiceItems(shopId, order);
      return { ok: true, data: transformOrder(order, { mileageUnit }, serviceItems) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? "Work order not found" };
    }
  }

  async getWorkOrders(shopId: number, options?: WorkOrderQuery): Promise<Result<NormalizedWorkOrder[]>> {
    if (!(await isConfigured(shopId))) return { ok: false, error: "Shopmonkey not configured" };

    try {
      const mileageUnit = await getMileageUnit(shopId);
      const orders = await getOrders(shopId, {
        updatedAfter: options?.fromDate?.toISOString(),
        vehicleId: options?.vehicleId,
        customerId: options?.customerId,
      });

      // Line items live on the separate `/service_item` endpoint. When the
      // query is scoped to a single vehicle/customer we can fetch every item in
      // one call and group by order id, avoiding an N+1 fan-out.
      if (options?.vehicleId || options?.customerId) {
        const items = await getServiceItems(shopId, {
          vehicleId: options?.vehicleId,
          customerId: options?.customerId,
        });
        const itemsByOrder = new Map<string, ShopmonkeyServiceItem[]>();
        for (const item of items) {
          const oid = String(item.order?.id ?? "");
          if (!oid) continue;
          const list = itemsByOrder.get(oid) ?? [];
          list.push(item);
          itemsByOrder.set(oid, list);
        }
        return {
          ok: true,
          data: orders.map((o) =>
            transformOrder(o, { mileageUnit }, itemsByOrder.get(String(o.id)) ?? []),
          ),
        };
      }

      // Unscoped: fetch line items per order in parallel.
      const data = await Promise.all(
        orders.map(async (o) => {
          const serviceItems = await getOrderServiceItems(shopId, o);
          return transformOrder(o, { mileageUnit }, serviceItems);
        }),
      );
      return { ok: true, data };
    } catch (err: any) {
      return { ok: false, error: err.message ?? "Failed to fetch work orders" };
    }
  }

  async getCannedJobs(shopId: number): Promise<Result<CannedJob[]>> {
    if (!(await isConfigured(shopId))) return { ok: false, error: "Shopmonkey not configured" };

    try {
      const jobs = await getCannedServices(shopId);
      return { ok: true, data: jobs.map(transformCannedService) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? "Failed to fetch canned jobs" };
    }
  }

  async runIncrementalSync(shopId: number): Promise<SyncResult> {
    if (!(await isConfigured(shopId))) {
      return { ok: false, recordsProcessed: 0, error: "Shopmonkey not configured" };
    }

    try {
      const db = await getDb();
      const shop = await db.collection("shops").findOne(
        { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
        { projection: { "shopmonkey.lastSyncAt": 1 } },
      );

      const lastSyncAt = shop?.shopmonkey?.lastSyncAt
        ? new Date(shop.shopmonkey.lastSyncAt).toISOString()
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const orders = await getOrders(shopId, { updatedAfter: lastSyncAt });
      // Live v3 orders carry no embedded line items; attach `/service_item`
      // lines so the normalized ingestion path can map jobs/line items.
      await attachServiceItems(shopId, orders);

      // Actually persist what we fetched (this path previously discarded the
      // orders — the webhook was the only writer).
      const ingest = await ingestShopmonkeyOrders(db, shopId, orders, "incremental_sync");
      if (ingest.hardFailures > 0) {
        // Don't advance lastSyncAt past orders that failed to persist — the
        // next cycle re-fetches from the same watermark (upserts are safe).
        return {
          ok: false,
          recordsProcessed: orders.length,
          error: `${ingest.hardFailures} ingestion batch(es) failed; lastSyncAt not advanced`,
        };
      }

      await db.collection("shops").updateOne(
        { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
        { $set: { "shopmonkey.lastSyncAt": new Date().toISOString() } },
      );

      return { ok: true, recordsProcessed: orders.length };
    } catch (err: any) {
      return { ok: false, recordsProcessed: 0, error: err.message };
    }
  }

  /**
   * One bounded, checkpointed backfill chunk (reworked after the 2026-08-06
   * saturation incident — the previous version re-fetched an entire YEAR of
   * orders on EVERY 5-min cron tick with an unbounded per-order fan-out, and
   * then never persisted any of it).
   *
   * Per tick this now:
   *  1. resumes from the pagination checkpoint stored on the shop's
   *     `shopmonkey_backfill_progress` doc (`fetchCursor`),
   *  2. fetches a bounded number of order pages (default 1 page = 100 orders;
   *     env `SHOPMONKEY_BACKFILL_PAGES_PER_TICK`),
   *  3. attaches `/service_item` lines with bounded concurrency
   *     (env `SHOPMONKEY_BACKFILL_ITEM_CONCURRENCY`, default 3),
   *  4. actually ingests the orders into the normalized store,
   *  5. advances the checkpoint; `complete` only once pagination is exhausted.
   */
  async runBackfill(shopId: number, options?: BackfillOptions): Promise<BackfillResult> {
    if (!(await isConfigured(shopId))) {
      return { ok: false, chunksProcessed: 0, totalJobsIndexed: 0, complete: false, error: "Shopmonkey not configured" };
    }

    try {
      const db = await getDb();
      const pagesPerTick = Math.min(
        5,
        Math.max(1, Number(process.env.SHOPMONKEY_BACKFILL_PAGES_PER_TICK) || 1),
      );

      // Resume from the stored checkpoint. `closedAfter` is frozen at the
      // start of a run so pagination stays stable across ticks.
      const progress = await db
        .collection(PROGRESS_COLLECTION)
        .findOne({ shopId }, { projection: { fetchCursor: 1 } });
      const fromDate = options?.fromDate ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      const cursorState: { closedAfter: string; cursor: string | null; offset: number } =
        progress?.fetchCursor && typeof progress.fetchCursor.closedAfter === "string"
          ? progress.fetchCursor
          : { closedAfter: fromDate.toISOString(), cursor: null, offset: 0 };

      const page = await getOrdersPaged(shopId, {
        closedAfter: cursorState.closedAfter,
        cursor: cursorState.cursor,
        offset: cursorState.offset,
        maxPages: pagesPerTick,
      });

      await options?.heartbeat?.();

      // Attach `/service_item` lines so the normalized ingestion path produces
      // real service jobs + line items (live v3 has no embedded line items).
      await attachServiceItems(shopId, page.orders);

      await options?.heartbeat?.();

      const { jobsIndexed, hardFailures } = await ingestShopmonkeyOrders(
        db,
        shopId,
        page.orders,
        "backfill",
        options?.heartbeat,
      );

      // A batch that threw means some orders were NOT durably ingested: do not
      // advance the checkpoint (this tick will be retried from the same
      // position) and never mark complete.
      if (hardFailures > 0) {
        return {
          ok: false,
          chunksProcessed: 0,
          totalJobsIndexed: jobsIndexed,
          complete: false,
          error: `${hardFailures} ingestion batch(es) failed; checkpoint not advanced`,
        };
      }

      await db.collection(PROGRESS_COLLECTION).updateOne(
        { shopId },
        page.hasMore
          ? {
              $set: {
                shopId,
                fetchCursor: {
                  closedAfter: cursorState.closedAfter,
                  cursor: page.nextCursor,
                  offset: page.nextOffset,
                },
              },
            }
          : { $set: { shopId }, $unset: { fetchCursor: "" } },
        { upsert: true },
      );

      await db.collection("shops").updateOne(
        { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
        { $set: { "shopmonkey.lastBackfillAt": new Date().toISOString() } },
      );

      console.log(
        `[Shopmonkey Backfill] shop=${shopId}: ${page.orders.length} orders this chunk, ${jobsIndexed} jobs indexed, ${page.hasMore ? `resume offset=${page.nextOffset}` : "COMPLETE"}`,
      );

      return { ok: true, chunksProcessed: 1, totalJobsIndexed: jobsIndexed, complete: !page.hasMore };
    } catch (err: any) {
      return { ok: false, chunksProcessed: 0, totalJobsIndexed: 0, complete: false, error: err.message };
    }
  }
}

/**
 * Persist fetched Shopmonkey orders through the shared normalized ingestion
 * pipeline (same options as the webhook writer). The previous backfill and
 * incremental-sync paths fetched orders and THREW THEM AWAY — the webhook was
 * the only real writer.
 */
async function ingestShopmonkeyOrders(
  db: Awaited<ReturnType<typeof getDb>>,
  shopId: number,
  orders: ShopmonkeyOrder[],
  via: "backfill" | "incremental_sync",
  heartbeat?: () => Promise<void>,
): Promise<{ jobsIndexed: number; hardFailures: number }> {
  if (orders.length === 0) return { jobsIndexed: 0, hardFailures: 0 };

  const shopDoc = await db.collection("shops").findOne(
    { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
    { projection: { enterpriseId: 1 } },
  );

  const ingestionService = new NormalizedIngestionService(
    db,
    "shopmonkey",
    shopId,
    shopDoc?.enterpriseId as string | undefined,
    { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true, ingestionVia: via },
  );

  let jobsIndexed = 0;
  let hardFailures = 0;
  const BATCH = 20;
  for (let i = 0; i < orders.length; i += BATCH) {
    const batch = orders.slice(i, i + BATCH);
    try {
      const r = await ingestionService.ingestWorkOrderBatchWithAllEntities(batch);
      jobsIndexed += (r.serviceJobs?.created || 0) + (r.serviceJobs?.updated || 0);
    } catch (err: any) {
      // Keep processing the remaining batches (ingestion is upsert-based so
      // re-running them later is safe) but count the failure so the caller
      // refuses to advance its checkpoint — otherwise these orders would be
      // silently skipped forever.
      hardFailures++;
      console.error(`[Shopmonkey Ingest] shop=${shopId} batch@${i} error:`, err?.message);
    }
    await heartbeat?.();
  }
  return { jobsIndexed, hardFailures };
}

/**
 * Fetch `/service_item` line items for each order and attach them as
 * `order.serviceItems` (in place). Shopmonkey v3 does not embed line items on an
 * order, so the ingestion/normalized path relies on this to produce real
 * service jobs + line items. Failures per order are swallowed to an empty list
 * so one bad order can't abort the whole batch.
 */
async function attachServiceItems(shopId: number, orders: ShopmonkeyOrder[]): Promise<void> {
  // Bounded concurrency: the previous unbounded Promise.all fanned out one
  // /service_item fetch per order for EVERY order at once, monopolizing the
  // web instance during backfill runs.
  const concurrency = Math.min(
    10,
    Math.max(1, Number(process.env.SHOPMONKEY_BACKFILL_ITEM_CONCURRENCY) || 3),
  );
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, orders.length) }, async () => {
    while (next < orders.length) {
      const o = orders[next++];
      try {
        o.serviceItems = await getOrderServiceItems(shopId, o);
      } catch {
        o.serviceItems = o.serviceItems ?? [];
      }
    }
  });
  await Promise.all(workers);
}

export const shopmonkeyAdapter = new ShopmonkeyAdapter();
