// Repository for the `protractor_work_orders` collection.
//
// Cached Protractor work-order snapshots, keyed by (shopId, workOrderId).
// Read access patterns include lookup by RO number (cached doc shape
// preserves `data.WorkOrderNumber`) and listing all cached WOs for a
// service item.
import type { Collection, Document, Filter } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "protractor_work_orders";

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
  const col = await collection();
  return col.findOne({
    shopId,
    "data.WorkOrderNumber": roNumber,
  } as Filter<ProtractorWorkOrderCacheDoc>);
}

export async function listCachedWorkOrdersForServiceItem(
  shopId: number,
  serviceItemId: string,
  options?: { includeOpen?: boolean },
): Promise<ProtractorWorkOrderCacheDoc[]> {
  const col = await collection();
  const query: Filter<ProtractorWorkOrderCacheDoc> = { shopId, serviceItemId };
  if (options?.includeOpen) {
    query.completed = { $ne: true };
  }
  return col.find(query).sort({ fetchedAt: -1 }).toArray();
}
