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
  getOrderServiceItems,
  getServiceItems,
  getCannedServices,
} from "./client";
import { transformVehicle, transformOrder, transformCannedService } from "./transform";
import type { ShopmonkeyOrder, ShopmonkeyServiceItem } from "./types";
import { resolveShopDistanceUnit } from "@/lib/shop-distance-unit";

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

      await db.collection("shops").updateOne(
        { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
        { $set: { "shopmonkey.lastSyncAt": new Date().toISOString() } },
      );

      return { ok: true, recordsProcessed: orders.length };
    } catch (err: any) {
      return { ok: false, recordsProcessed: 0, error: err.message };
    }
  }

  async runBackfill(shopId: number, options?: BackfillOptions): Promise<BackfillResult> {
    if (!(await isConfigured(shopId))) {
      return { ok: false, chunksProcessed: 0, totalJobsIndexed: 0, complete: false, error: "Shopmonkey not configured" };
    }

    try {
      const fromDate = options?.fromDate ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      const orders = await getOrders(shopId, { closedAfter: fromDate.toISOString() });
      // Attach `/service_item` lines to each order so the normalized ingestion
      // path produces real service jobs + line items (live v3 has no embedded
      // line items on the order).
      await attachServiceItems(shopId, orders);

      const db = await getDb();
      await db.collection("shops").updateOne(
        { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
        {
          $set: {
            "shopmonkey.lastBackfillAt": new Date().toISOString(),
            "shopmonkey.lastSyncAt": new Date().toISOString(),
          },
        },
      );

      // One synthetic job per order that has line items (Shopmonkey v3 has no
      // job grouping under an order); fall back to any embedded `services[]`.
      const totalJobs = orders.reduce(
        (sum, o) => sum + (o.services?.length || (o.serviceItems?.length ? 1 : 0)),
        0,
      );

      return { ok: true, chunksProcessed: 1, totalJobsIndexed: totalJobs, complete: true };
    } catch (err: any) {
      return { ok: false, chunksProcessed: 0, totalJobsIndexed: 0, complete: false, error: err.message };
    }
  }
}

/**
 * Fetch `/service_item` line items for each order and attach them as
 * `order.serviceItems` (in place). Shopmonkey v3 does not embed line items on an
 * order, so the ingestion/normalized path relies on this to produce real
 * service jobs + line items. Failures per order are swallowed to an empty list
 * so one bad order can't abort the whole batch.
 */
async function attachServiceItems(shopId: number, orders: ShopmonkeyOrder[]): Promise<void> {
  await Promise.all(
    orders.map(async (o) => {
      try {
        o.serviceItems = await getOrderServiceItems(shopId, o);
      } catch {
        o.serviceItems = o.serviceItems ?? [];
      }
    }),
  );
}

export const shopmonkeyAdapter = new ShopmonkeyAdapter();
