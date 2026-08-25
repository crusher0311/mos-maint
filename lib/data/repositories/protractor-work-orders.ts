// Repository for the `protractor_work_orders` collection.
//
// Cached Protractor work-order snapshots, keyed by (shopId, workOrderId).
// Read access patterns include lookup by RO number (cached doc shape
// preserves `data.WorkOrderNumber`) and listing all cached WOs for a
// service item.
import type { Collection, Document, Filter } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isProtractorCachePgCanonical,
  shouldShadowWriteMongoProtractorCache,
  shadowWriteMongoIntegrationCache,
} from "@/lib/db/integration-cache-write-mode";
import * as pg from "./pg/protractor-cache";

const COLLECTION = "protractor_work_orders";
/** Up to two cache identities for each of the report's 300 scoped ROs. */
const MAX_BATCH_LOOKUP_IDS = 600;

export interface ProtractorWorkOrderCacheDoc extends Document {
  shopId: number;
  workOrderId: string;
  workOrderGuid?: string;
  workOrderNumber?: number | null;
  type?: string | null;
  status?: string | null;
  vin?: string | null;
  serviceItemId?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  companyName?: string | null;
  odometer?: number | null;
  workflowStage?: string | null;
  completed?: boolean;
  scheduledTime?: string | null;
  promisedTime?: string | null;
  servicePackages?: any[];
  packageSummaries?: any[];
  pricing?: {
    laborTotal: number;
    partsTotal: number;
    otherTotal: number;
    grandTotal: number;
  };
  fetchedAt?: Date;
  source?: string;
  rawPayload?: any;
  createdAt?: Date;
  // Legacy doc shape used by `resolveWorkOrderGuid` lookup.
  data?: { ID?: string; WorkOrderNumber?: number };
}

async function collection(): Promise<Collection<ProtractorWorkOrderCacheDoc>> {
  const db = await getDb();
  return db.collection<ProtractorWorkOrderCacheDoc>(COLLECTION);
}

export type ProtractorWorkOrderUpsertFields = Partial<
  Omit<ProtractorWorkOrderCacheDoc, "createdAt">
>;

export async function upsertWorkOrderSnapshot(
  shopId: number,
  workOrderId: string,
  set: ProtractorWorkOrderUpsertFields,
  now: Date,
): Promise<void> {
  if (isProtractorCachePgCanonical()) {
    await pg.upsertWorkOrderSnapshot(shopId, workOrderId, set, now);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoProtractorCache,
      "protractor.work_orders.upsert",
      () => upsertWorkOrderSnapshotMongo(shopId, workOrderId, set, now),
    );
    return;
  }
  await upsertWorkOrderSnapshotMongo(shopId, workOrderId, set, now);
}

async function upsertWorkOrderSnapshotMongo(
  shopId: number,
  workOrderId: string,
  set: ProtractorWorkOrderUpsertFields,
  now: Date,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId, workOrderId },
    { $set: set, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
}

export async function findCachedWorkOrderByLegacyRoNumber(
  shopId: number,
  roNumber: number,
): Promise<ProtractorWorkOrderCacheDoc | null> {
  if (isProtractorCachePgCanonical()) {
    return (await pg.findCachedWorkOrderByLegacyRoNumber(
      shopId,
      roNumber,
    )) as ProtractorWorkOrderCacheDoc | null;
  }
  const col = await collection();
  return col.findOne({
    shopId,
    "data.WorkOrderNumber": roNumber,
  } as Filter<ProtractorWorkOrderCacheDoc>);
}

// Task #903: RO-number lookup covering BOTH the current snapshot shape
// (top-level `workOrderNumber`) and the legacy shape (`data.WorkOrderNumber`),
// honoring the PG-canonical cache mode. Newest snapshot wins.
export async function findCachedWorkOrderByRoNumber(
  shopId: number,
  roNumber: number,
): Promise<ProtractorWorkOrderCacheDoc | null> {
  if (isProtractorCachePgCanonical()) {
    return (await pg.findCachedWorkOrderByRoNumber(
      shopId,
      roNumber,
    )) as ProtractorWorkOrderCacheDoc | null;
  }
  const col = await collection();
  return col.findOne(
    {
      shopId,
      $or: [{ workOrderNumber: roNumber }, { "data.WorkOrderNumber": roNumber }],
    } as Filter<ProtractorWorkOrderCacheDoc>,
    { projection: { rawPayload: 0, servicePackages: 0 }, sort: { fetchedAt: -1 } },
  );
}

// Open (non-completed) WOs in a sellable workflow stage that carry pricing —
// used by the dashboard Sales Coach. Deduped by workOrderId, newest first.
const SELLABLE_STAGES = [
  "EstimateCompleted",
  "WorkAuthorized",
  "InspectionInProgress",
  "InspectionComplete",
  "Unassigned",
];

export async function listOpenWorkOrdersWithPricing(
  shopId: number,
  limit = 25,
): Promise<ProtractorWorkOrderCacheDoc[]> {
  if (isProtractorCachePgCanonical()) {
    return (await pg.listOpenWorkOrdersWithPricing(
      shopId,
      limit,
    )) as ProtractorWorkOrderCacheDoc[];
  }
  const col = await collection();
  const docs = await col
    .find({
      shopId,
      completed: { $ne: true },
      workflowStage: { $in: SELLABLE_STAGES },
      "pricing.grandTotal": { $gt: 0 },
    } as Filter<ProtractorWorkOrderCacheDoc>)
    .project({ rawPayload: 0, servicePackages: 0 })
    .sort({ fetchedAt: -1 })
    .limit(limit * 3)
    .toArray();
  const seen = new Set<string>();
  const out: ProtractorWorkOrderCacheDoc[] = [];
  for (const d of docs as ProtractorWorkOrderCacheDoc[]) {
    if (!d.workOrderId || seen.has(d.workOrderId)) continue;
    seen.add(d.workOrderId);
    out.push(d);
    if (out.length >= limit) break;
  }
  return out;
}

export async function findCachedWorkOrderById(
  shopId: number,
  workOrderId: string,
): Promise<ProtractorWorkOrderCacheDoc | null> {
  if (isProtractorCachePgCanonical()) {
    return (await pg.findCachedWorkOrderById(
      shopId,
      workOrderId,
    )) as ProtractorWorkOrderCacheDoc | null;
  }
  const col = await collection();
  return col.findOne(
    { shopId, workOrderId } as Filter<ProtractorWorkOrderCacheDoc>,
    { projection: { rawPayload: 0, servicePackages: 0 }, sort: { fetchedAt: -1 } },
  );
}

/**
 * Bounded cache-only lookup used when recovering package details for already
 * normalized jobs. Unlike the single-record lookup, this intentionally
 * includes servicePackages and rawPayload.
 */
export async function findCachedWorkOrdersByIds(
  shopId: number,
  workOrderIds: string[],
): Promise<ProtractorWorkOrderCacheDoc[]> {
  const ids = Array.from(
    new Set(workOrderIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ).slice(0, MAX_BATCH_LOOKUP_IDS);
  if (ids.length === 0) return [];
  if (isProtractorCachePgCanonical()) {
    return (await pg.findCachedWorkOrdersByIds(
      shopId,
      ids,
    )) as ProtractorWorkOrderCacheDoc[];
  }
  const col = await collection();
  return col
    .find(
      { shopId, workOrderId: { $in: ids } } as Filter<ProtractorWorkOrderCacheDoc>,
    )
    .sort({ fetchedAt: -1 })
    .toArray();
}

/**
 * Resolve Protractor's opaque work-order GUIDs to the human-facing RO numbers
 * already stored in the provider cache. The Missed Opportunities report uses
 * this bounded batch lookup to repair display-only legacy rows normalized
 * before WorkOrderNumber was preferred over InvoiceNumber/ID.
 */
export async function findDisplayRoNumbersByIds(
  shopId: number,
  workOrderIds: string[],
): Promise<Record<string, string>> {
  const ids = Array.from(new Set(workOrderIds.filter(Boolean))).slice(0, 300);
  if (ids.length === 0) return {};

  if (isProtractorCachePgCanonical()) {
    return pg.findDisplayRoNumbersByIds(shopId, ids);
  }

  const col = await collection();
  const docs = await col
    .find(
      { shopId, workOrderId: { $in: ids } } as Filter<ProtractorWorkOrderCacheDoc>,
      {
        projection: {
          _id: 0,
          workOrderId: 1,
          workOrderNumber: 1,
          "data.WorkOrderNumber": 1,
        },
      },
    )
    .toArray();

  const out: Record<string, string> = {};
  for (const doc of docs) {
    const number = doc.workOrderNumber ?? doc.data?.WorkOrderNumber;
    if (doc.workOrderId && Number.isFinite(Number(number)) && Number(number) > 0) {
      out[doc.workOrderId] = String(number);
    }
  }
  return out;
}

export async function listCachedWorkOrdersForServiceItem(
  shopId: number,
  serviceItemId: string,
  options?: { includeOpen?: boolean },
): Promise<ProtractorWorkOrderCacheDoc[]> {
  if (isProtractorCachePgCanonical()) {
    return (await pg.listCachedWorkOrdersForServiceItem(
      shopId,
      serviceItemId,
      options,
    )) as ProtractorWorkOrderCacheDoc[];
  }
  const col = await collection();
  const query: Filter<ProtractorWorkOrderCacheDoc> = { shopId, serviceItemId };
  if (options?.includeOpen) {
    query.completed = { $ne: true };
  }
  return col.find(query).sort({ fetchedAt: -1 }).toArray();
}
