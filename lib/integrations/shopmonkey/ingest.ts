/**
 * Shopmonkey shared persistence layer (task: Shopmonkey service-job history).
 *
 * Every Shopmonkey ingest path (full-page backfill, incremental sync, webhook,
 * and the operator re-normalize script) funnels through here so cached rows in
 * `shopmonkey_work_orders` and the normalized stores (+ `job_index` history
 * dual-write) stay in lockstep. Before this module existed the adapter's
 * runBackfill/runIncrementalSync fetched orders and then dropped them on the
 * floor — only the webhook wrote anything, with `dualWriteToJobIndex: false`
 * and no `/service_item` lines attached, which is why the connected shops had
 * work orders but ZERO service-job history (VHI fell back to CARFAX).
 *
 * Amounts in Shopmonkey are CENTS; the normalized adapter converts.
 */

import type { Db } from "mongodb";
import { getDb } from "@/lib/mongo";
import { NormalizedIngestionService } from "@/lib/integrations/core/normalized-ingestion";
import {
  getOrderServiceItems,
  getServiceItems,
  getVehicle as getShopmonkeyVehicle,
  getCustomer as getShopmonkeyCustomer,
} from "./client";
import type { ShopmonkeyOrder } from "./types";

const CACHE_COLLECTION = "shopmonkey_work_orders";

const TERMINAL_STATUSES = [
  "invoice",
  "invoiced",
  "posted",
  "complete",
  "completed",
  "archived",
  "deleted",
];

export function isTerminalShopmonkeyStatus(status: unknown): boolean {
  const s = String(status ?? "").toLowerCase();
  return TERMINAL_STATUSES.some((t) => s.includes(t));
}

/**
 * Upsert one order onto its `shopmonkey_work_orders` cache row — the same
 * shape the webhook receiver writes, so dashboards and the re-normalize path
 * read one consistent cache regardless of which pipeline saw the order last.
 */
export async function upsertShopmonkeyWorkOrderCache(
  db: Db,
  shopId: number,
  order: any,
): Promise<void> {
  const orderId = String(order.id);
  const orderNumber = order.number ?? order.invoiceNumber ?? orderId;
  const statusName = String(order.status || "");

  const setFields: any = {
    shopId: String(shopId),
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
  if (isTerminalShopmonkeyStatus(statusName)) setFields.closedAt = new Date();

  await db.collection(CACHE_COLLECTION).updateOne(
    { workOrderId: orderId },
    {
      $set: setFields,
      $setOnInsert: { workOrderId: orderId, createdAt: new Date() },
    },
    { upsert: true },
  );
}

export interface ShopmonkeyIngestSummary {
  orders: number;
  workOrdersCreated: number;
  workOrdersUpdated: number;
  workOrdersSkipped: number;
  workOrdersErrored: number;
  serviceJobsWritten: number;
  serviceJobErrors: number;
  lineItemsWritten: number;
}

/**
 * Persist a batch of (service-item-enriched) orders: cache rows + the
 * normalized stores + the `job_index` history dual-write (which the
 * ingestion service gates to terminal orders for Shopmonkey so estimates
 * never become "performed service" anchors).
 */
export async function ingestShopmonkeyOrders(
  shopId: number,
  orders: ShopmonkeyOrder[],
  opts: { via: string; enterpriseId?: string; writeCache?: boolean; forceUpdate?: boolean },
): Promise<ShopmonkeyIngestSummary> {
  const db = await getDb();

  if (opts.writeCache !== false) {
    for (const order of orders) {
      if (!order?.id) continue;
      await upsertShopmonkeyWorkOrderCache(db, shopId, order);
    }
  }

  const service = new NormalizedIngestionService(db, "shopmonkey", shopId, opts.enterpriseId, {
    dualWriteToJobIndex: true,
    dualWriteToRepairPatterns: true,
    ingestionVia: opts.via,
    // forceUpdate matters for re-normalize repair runs: an unchanged
    // contentHash short-circuits BEFORE the job_index dual-write, so shops
    // whose WOs were already ingested (without history) would stay at 0.
    ...(opts.forceUpdate ? { forceUpdate: true } : {}),
  });

  const result = await service.ingestWorkOrderBatchWithAllEntities(
    orders.filter((o: any) => o?.id),
  );

  return {
    orders: orders.length,
    workOrdersCreated: result.workOrders.created,
    workOrdersUpdated: result.workOrders.updated,
    workOrdersSkipped: result.workOrders.skipped,
    workOrdersErrored: result.workOrders.errors,
    serviceJobsWritten: result.serviceJobs.created + result.serviceJobs.updated,
    serviceJobErrors: result.serviceJobs.errors,
    lineItemsWritten: result.lineItems.created + result.lineItems.updated,
  };
}

/**
 * Enrich one cached/webhook order in place so the normalized adapter has what
 * it needs: `/service_item` lines (live v3 never embeds them), plus vehicle /
 * customer subdocs when only the ids are present. Every fetch is best-effort —
 * a miss degrades the record, it never blocks ingestion. NOTE: a missing VIN
 * is NOT a blocker (marine shops have VIN-less units); the work order still
 * normalizes and its history rows simply carry no VIN.
 */
export async function enrichShopmonkeyOrder(
  shopId: number,
  order: any,
  opts: {
    skipServiceItemsFetch?: boolean;
    /** Per-run memo caches — many orders share one vehicle/customer. */
    vehicleCache?: Map<string, any>;
    customerCache?: Map<string, any>;
  } = {},
): Promise<any> {
  const enriched = { ...order };

  if (
    !opts.skipServiceItemsFetch &&
    (!Array.isArray(enriched.serviceItems) || enriched.serviceItems.length === 0)
  ) {
    try {
      enriched.serviceItems = await getOrderServiceItems(shopId, enriched);
    } catch {
      enriched.serviceItems = enriched.serviceItems ?? [];
    }
  }

  if (!enriched.vehicle && enriched.vehicleId) {
    const vid = String(enriched.vehicleId);
    if (opts.vehicleCache?.has(vid)) {
      enriched.vehicle = opts.vehicleCache.get(vid);
    } else {
      try {
        enriched.vehicle = await getShopmonkeyVehicle(shopId, vid);
      } catch {}
      opts.vehicleCache?.set(vid, enriched.vehicle ?? null);
    }
  }

  if (
    !(enriched.customer?.firstName || enriched.customer?.lastName || enriched.customer?.companyName) &&
    enriched.customerId
  ) {
    const cid = String(enriched.customerId);
    if (opts.customerCache?.has(cid)) {
      enriched.customer = opts.customerCache.get(cid);
    } else {
      try {
        enriched.customer = await getShopmonkeyCustomer(shopId, cid);
      } catch {}
      opts.customerCache?.set(cid, enriched.customer ?? null);
    }
  }

  return enriched;
}

export interface AttachServiceItemsStats {
  orders: number;
  ordersNeedingItems: number;
  ordersAttached: number;
  groups: number;
  groupsFailed: number;
}

/**
 * Batch-attach `/service_item` lines onto orders IN PLACE. The endpoint only
 * filters by customerId/vehicleId, so ONE call per customer (fallback:
 * vehicle) group covers ALL of that group's orders — per-order fan-out both
 * hammers the Cloudflare rate limit and times out the shared limiter's slot
 * queue, silently dropping lines. Calls run SEQUENTIALLY (the shared limiter
 * paces them) and each failed group is retried once; persistent failures are
 * surfaced in the returned stats + a warn log, and the affected orders keep
 * `serviceItems` undefined so the has-money fallback still yields a job while
 * making the degradation observable (never an invisible empty-lines write).
 *
 * `deps.fetchServiceItems` is injectable for tests.
 */
export async function attachServiceItemsBatched(
  shopId: number,
  orders: any[],
  deps: {
    fetchServiceItems?: (
      shopId: number,
      filter: { customerId?: string; vehicleId?: string },
    ) => Promise<any[]>;
    log?: (msg: string) => void;
  } = {},
): Promise<AttachServiceItemsStats> {
  const fetchItems = deps.fetchServiceItems ?? getServiceItems;
  const log = deps.log ?? ((m: string) => console.log(m));

  const needing = orders.filter(
    (o) => o?.id && !(Array.isArray(o.serviceItems) && o.serviceItems.length > 0),
  );

  // Group by customerId first (broadest coverage), vehicleId as fallback.
  const groups = new Map<string, { filter: { customerId?: string; vehicleId?: string }; orders: any[] }>();
  for (const order of needing) {
    let key: string | null = null;
    let filter: { customerId?: string; vehicleId?: string } | null = null;
    if (order.customerId) {
      key = `c:${order.customerId}`;
      filter = { customerId: String(order.customerId) };
    } else if (order.vehicleId ?? order.vehicle?.id) {
      const vid = String(order.vehicleId ?? order.vehicle?.id);
      key = `v:${vid}`;
      filter = { vehicleId: vid };
    }
    if (!key || !filter) continue; // no valid /service_item filter exists
    const g = groups.get(key) ?? { filter, orders: [] };
    g.orders.push(order);
    groups.set(key, g);
  }

  const itemsByOrderId = new Map<string, any[]>();
  let groupsFailed = 0;
  for (const [, group] of groups) {
    let items: any[] | null = null;
    for (let attempt = 0; attempt < 2 && items == null; attempt++) {
      try {
        items = await fetchItems(shopId, group.filter);
      } catch {
        items = null;
      }
    }
    if (items == null) {
      groupsFailed++;
      continue;
    }
    for (const item of items) {
      const oid = String(item?.order?.id ?? item?.orderId ?? "");
      if (!oid) continue;
      const arr = itemsByOrderId.get(oid) ?? [];
      arr.push(item);
      itemsByOrderId.set(oid, arr);
    }
    // Every order in a SUCCESSFUL group is covered — even a legit zero-line
    // order gets an explicit [] so nothing downstream re-fetches it.
    for (const order of group.orders) {
      order.serviceItems = itemsByOrderId.get(String(order.id)) ?? [];
    }
  }

  const ordersAttached = needing.filter((o) => Array.isArray(o.serviceItems)).length;
  const stats: AttachServiceItemsStats = {
    orders: orders.length,
    ordersNeedingItems: needing.length,
    ordersAttached,
    groups: groups.size,
    groupsFailed,
  };
  if (groupsFailed > 0 || ordersAttached < needing.length) {
    log(
      `[Shopmonkey] service-item attach DEGRADED shop=${shopId}: attached ${ordersAttached}/${needing.length} orders, ${groupsFailed}/${groups.size} groups failed after retry`,
    );
  }
  return stats;
}

export interface RenormalizeResult {
  shopId: number;
  cachedRows: number;
  processed: number;
  skippedNoData: number;
  summary: ShopmonkeyIngestSummary;
}

/**
 * Re-normalize a shop's already-cached `shopmonkey_work_orders` rows into the
 * normalized stores + job_index, enriching each order (service items, vehicle,
 * customer) from the API where the cached payload is thin. This is the repair
 * path for shops whose cache filled up (webhooks) while normalization never
 * ran — no full history re-pull needed.
 */
export async function renormalizeShopmonkeyShopFromCache(
  shopId: number,
  opts: { batchSize?: number; log?: (msg: string) => void } = {},
): Promise<RenormalizeResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const batchSize = opts.batchSize ?? 25;
  const db = await getDb();

  const cursor = db
    .collection(CACHE_COLLECTION)
    .find({ shopId: { $in: [String(shopId), shopId as any] } })
    .sort({ _id: 1 });

  const totals: ShopmonkeyIngestSummary = {
    orders: 0,
    workOrdersCreated: 0,
    workOrdersUpdated: 0,
    workOrdersSkipped: 0,
    workOrdersErrored: 0,
    serviceJobsWritten: 0,
    serviceJobErrors: 0,
    lineItemsWritten: 0,
  };
  let cachedRows = 0;
  let processed = 0;
  let skippedNoData = 0;
  let batch: any[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    // writeCache=false: source of truth here IS the cache; only refresh the
    // cache row when we actually enriched the payload (service items /
    // vehicle) so the next re-run doesn't need the API again.
    for (const order of batch) {
      if (order.__enriched) {
        delete order.__enriched;
        await upsertShopmonkeyWorkOrderCache(db, shopId, order);
      }
    }
    const s = await ingestShopmonkeyOrders(shopId, batch, {
      via: "renormalize",
      writeCache: false,
      forceUpdate: true,
    });
    totals.orders += s.orders;
    totals.workOrdersCreated += s.workOrdersCreated;
    totals.workOrdersUpdated += s.workOrdersUpdated;
    totals.workOrdersSkipped += s.workOrdersSkipped;
    totals.workOrdersErrored += s.workOrdersErrored;
    totals.serviceJobsWritten += s.serviceJobsWritten;
    totals.serviceJobErrors += s.serviceJobErrors;
    totals.lineItemsWritten += s.lineItemsWritten;
    processed += batch.length;
    log(
      `[SM Renormalize] shop=${shopId} processed=${processed} WO ${totals.workOrdersCreated}c/${totals.workOrdersUpdated}u/${totals.workOrdersSkipped}s/${totals.workOrdersErrored}e, serviceJobs=${totals.serviceJobsWritten} (${totals.serviceJobErrors}e), lineItems=${totals.lineItemsWritten}`,
    );
    batch = [];
  };

  // Pass 1: load all cached orders and group the ones needing line items by
  // customerId. `/service_item` only filters by customer/vehicle, so ONE call
  // per customer covers ALL of that customer's orders — without this, a
  // 4k-order shop is 4k rate-limited API calls.
  const orders: any[] = [];
  for await (const doc of cursor) {
    cachedRows++;
    const order = (doc as any)?.data;
    if (!order?.id) {
      skippedNoData++;
      continue;
    }
    orders.push(order);
  }

  const attachStats = await attachServiceItemsBatched(shopId, orders, { log });
  log(
    `[SM Renormalize] shop=${shopId} service-item prefetch: attached ${attachStats.ordersAttached}/${attachStats.ordersNeedingItems} orders via ${attachStats.groups} groups (${attachStats.groupsFailed} failed)`,
  );

  const runVehicleCache = new Map<string, any>();
  const runCustomerCache = new Map<string, any>();

  for (const order of orders) {
    const before = Array.isArray(order.serviceItems) ? order.serviceItems.length : -1;
    const hadVehicle = !!order.vehicle;
    // The batched attach already covered every order it could resolve a
    // filter for — don't re-fan-out one /service_item call per order.
    const enriched = await enrichShopmonkeyOrder(shopId, order, {
      skipServiceItemsFetch: Array.isArray(order.serviceItems),
      vehicleCache: runVehicleCache,
      customerCache: runCustomerCache,
    });
    const after = Array.isArray(enriched.serviceItems) ? enriched.serviceItems.length : -1;
    if (after !== before || (!hadVehicle && enriched.vehicle)) enriched.__enriched = true;
    batch.push(enriched);
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  return { shopId, cachedRows, processed, skippedNoData, summary: totals };
}
