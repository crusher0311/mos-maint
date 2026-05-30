// Repository for Shop-Ware webhook persistence.
//
// Backs the `app/api/webhooks/shopware/route.ts` endpoint. The webhook
// writes to a handful of cache collections (repair orders, vehicles,
// customers), an audit log (`shopware_webhook_logs` + the global
// `events` log), and the shared `dashboard_updates` heartbeat. It also
// kicks off plan prefetch and VHI rebuild side-effects that need a Db
// handle — those are exposed here as thin wrappers so the webhook
// itself never reaches for `getDb()` directly.
import type {
  Collection,
  Document,
  ObjectId as ObjectIdType,
} from "mongodb";
import { getDb } from "@/lib/data/db";
import { computeJobHash } from "@/lib/job-index";
import { isPlanPrefetched, prefetchPlanData } from "@/lib/plan-builder";
import {
  triggerVhiOnWorkOrderCreate,
  triggerVhiOnWorkOrderClose,
  type VhiTriggerInput,
} from "@/lib/vhi-webhook-trigger";
import {
  isShopwareCachePgCanonical,
  shouldShadowWriteMongoShopwareCache,
  shadowWriteMongoIntegrationCache,
} from "@/lib/db/integration-cache-write-mode";
import * as pg from "./pg/shopware-cache";

const REPAIR_ORDERS = "shopware_repair_orders";
const VEHICLES = "shopware_vehicles";
const CUSTOMERS = "shopware_customers";
const WEBHOOK_LOGS = "shopware_webhook_logs";
const EVENTS = "events";
const DASHBOARD_UPDATES = "dashboard_updates";
const JOB_INDEX = "job_index";

async function col(name: string): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(name);
}

// --- repair orders -------------------------------------------------------

export interface RepairOrderUpsertData extends Document {
  mosShopId?: number;
  roId?: number;
  tenantId?: number;
  swShopId?: number;
  number?: number | null;
  state?: string | null;
  vin?: string | null;
  customerId?: number | null;
  vehicleId?: number | null;
  customerName?: string | null;
  vehicleYear?: number | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  odometer?: number | null;
  serviceCount?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  closedAt?: Date | null;
  raw?: unknown;
  syncedAt?: Date;
  partialFromWebhook?: boolean;
  fetchError?: string;
}

export async function markRepairOrderDeleted(
  mosShopId: number,
  roId: number,
): Promise<void> {
  if (isShopwareCachePgCanonical()) {
    await pg.markRepairOrderDeleted(mosShopId, roId);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoShopwareCache,
      "shopware.repair_orders.markDeleted",
      () => markRepairOrderDeletedMongo(mosShopId, roId),
    );
    return;
  }
  await markRepairOrderDeletedMongo(mosShopId, roId);
}

async function markRepairOrderDeletedMongo(
  mosShopId: number,
  roId: number,
): Promise<void> {
  const c = await col(REPAIR_ORDERS);
  await c.updateMany(
    { mosShopId, roId },
    { $set: { deleted: true, deletedAt: new Date(), deletedViaWebhook: true } },
  );
}

export async function upsertRepairOrder(
  mosShopId: number,
  roId: number,
  data: RepairOrderUpsertData,
): Promise<void> {
  if (isShopwareCachePgCanonical()) {
    await pg.upsertRepairOrder(mosShopId, roId, data);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoShopwareCache,
      "shopware.repair_orders.upsert",
      () => upsertRepairOrderMongo(mosShopId, roId, data),
    );
    return;
  }
  await upsertRepairOrderMongo(mosShopId, roId, data);
}

async function upsertRepairOrderMongo(
  mosShopId: number,
  roId: number,
  data: RepairOrderUpsertData,
): Promise<void> {
  const c = await col(REPAIR_ORDERS);
  await c.updateOne({ mosShopId, roId }, { $set: data }, { upsert: true });
}

// --- vehicles / customers -----------------------------------------------

export interface VehicleUpsertData extends Document {
  mosShopId?: number;
  vehicleId?: number;
  tenantId?: number;
  vin?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  licensePlate?: string | null;
  updatedAt?: Date;
  raw?: unknown;
}

export async function upsertVehicle(
  mosShopId: number,
  vehicleId: number,
  data: VehicleUpsertData,
): Promise<void> {
  if (isShopwareCachePgCanonical()) {
    await pg.upsertVehicle(mosShopId, vehicleId, data);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoShopwareCache,
      "shopware.vehicles.upsert",
      () => upsertVehicleMongo(mosShopId, vehicleId, data),
    );
    return;
  }
  await upsertVehicleMongo(mosShopId, vehicleId, data);
}

async function upsertVehicleMongo(
  mosShopId: number,
  vehicleId: number,
  data: VehicleUpsertData,
): Promise<void> {
  const c = await col(VEHICLES);
  await c.updateOne({ mosShopId, vehicleId }, { $set: data }, { upsert: true });
}

export interface CustomerUpsertData extends Document {
  mosShopId?: number;
  customerId?: number;
  tenantId?: number;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  updatedAt?: Date;
  raw?: unknown;
}

export async function upsertCustomer(
  mosShopId: number,
  customerId: number,
  data: CustomerUpsertData,
): Promise<void> {
  if (isShopwareCachePgCanonical()) {
    await pg.upsertCustomer(mosShopId, customerId, data);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoShopwareCache,
      "shopware.customers.upsert",
      () => upsertCustomerMongo(mosShopId, customerId, data),
    );
    return;
  }
  await upsertCustomerMongo(mosShopId, customerId, data);
}

async function upsertCustomerMongo(
  mosShopId: number,
  customerId: number,
  data: CustomerUpsertData,
): Promise<void> {
  const c = await col(CUSTOMERS);
  await c.updateOne(
    { mosShopId, customerId },
    { $set: data },
    { upsert: true },
  );
}

// --- webhook log + global events feed -----------------------------------

export interface WebhookLogDoc {
  _id?: ObjectIdType;
  provider: string;
  webhookId: string;
  event: string;
  tenantId: number;
  resourceId: number;
  timestamp: string;
  payload: unknown;
  raw: string;
  receivedAt: Date;
  processed: boolean;
  processedAt: Date | null;
  processingError: string | null;
}

export async function insertWebhookLog(
  log: Omit<WebhookLogDoc, "_id">,
): Promise<ObjectIdType> {
  // Mirror to the generic events feed and the shopware-specific log so
  // platform admins can drill in from either surface.
  const events = await col(EVENTS);
  await events.insertOne({ ...log });
  const swLogs = await col(WEBHOOK_LOGS);
  const inserted = await swLogs.insertOne({ ...log });
  return inserted.insertedId;
}

export async function markWebhookProcessed(
  id: ObjectIdType,
): Promise<void> {
  const c = await col(WEBHOOK_LOGS);
  await c.updateOne(
    { _id: id },
    { $set: { processed: true, processedAt: new Date() } },
  );
}

export async function markWebhookFailed(
  id: ObjectIdType,
  error: string,
): Promise<void> {
  const c = await col(WEBHOOK_LOGS);
  await c
    .updateOne(
      { _id: id },
      {
        $set: {
          processed: false,
          processedAt: new Date(),
          processingError: error,
        },
      },
    )
    .catch(() => {});
}

// --- dashboard heartbeat ------------------------------------------------

export async function touchDashboardUpdate(): Promise<void> {
  const c = await col(DASHBOARD_UPDATES);
  await c.updateOne(
    { _id: "lastUpdate" } as Document,
    { $set: { timestamp: Date.now() } },
    { upsert: true },
  );
}

// --- side-effects (plan prefetch + VHI triggers) ------------------------
//
// These wrap helpers that take a `Db` so the webhook can stay free of
// `getDb()` imports. They preserve the original behavior verbatim.

export async function prefetchPlanIfNeeded(
  shopId: number,
  vin: string,
  mileage: number,
): Promise<{ cached: boolean; duration?: number }> {
  const db = await getDb();
  const alreadyCached = await isPlanPrefetched(db, vin, shopId);
  if (alreadyCached) return { cached: true };
  const result = await prefetchPlanData(db, shopId, vin, mileage);
  return { cached: false, duration: result.duration };
}

export async function fireVhiOnWorkOrderCreate(
  input: VhiTriggerInput,
): Promise<void> {
  const db = await getDb();
  await triggerVhiOnWorkOrderCreate(db, input);
}

export async function fireVhiOnWorkOrderClose(
  input: VhiTriggerInput,
): Promise<void> {
  const db = await getDb();
  await triggerVhiOnWorkOrderClose(db, input);
}

// --- shopware-flavored job index upsert ---------------------------------
//
// Shop-Ware writes a flatter document into `job_index` than the
// canonical `JobIndexEntry` shape produced by `upsertJobIndexEntries`.
// Preserve the historical doc shape and the contentHash-based dedup
// so existing readers keep working.
export interface ShopwareJobIndexEntry {
  shopId: number;
  provider: string;
  tenantId: number;
  workOrderId: string;
  workOrderNumber?: number;
  servicePackageId: string;
  title: string;
  status: string;
  vin: string | null;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  laborHours: number;
  laborAmount: number;
  partsAmount: number;
  totalAmount: number;
  completedAt?: Date;
  mileage: number | null;
  indexedAt: Date;
}

interface JobIndexCacheDoc extends Document {
  contentHash?: string;
}

export async function upsertShopwareJobIndexEntries(
  entries: ShopwareJobIndexEntry[],
): Promise<{ indexed: number; skipped: number }> {
  if (entries.length === 0) return { indexed: 0, skipped: 0 };
  const c = await col(JOB_INDEX);
  let indexed = 0;
  let skipped = 0;
  for (const entry of entries) {
    // computeJobHash hashes whatever stable fields are present, which
    // works for both the canonical JobIndexEntry shape and the flatter
    // Shop-Ware shape stored historically.
    const contentHash = computeJobHash(entry as never);
    const filter = {
      shopId: entry.shopId,
      provider: "shopware",
      workOrderId: entry.workOrderId,
      servicePackageId: entry.servicePackageId,
    };
    const existing = (await c.findOne(filter)) as JobIndexCacheDoc | null;
    if (existing?.contentHash === contentHash) {
      skipped++;
      continue;
    }
    await c.updateOne(filter, { $set: { ...entry, contentHash } }, { upsert: true });
    indexed++;
  }
  return { indexed, skipped };
}
