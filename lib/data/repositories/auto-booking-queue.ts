// Repository for the `auto_booking_queue` collection.
//
// The queue document shape is loose today and varies between callers
// (bookings created from oil change reminders, manual escalations,
// admin retries…). The repository exposes a typed but extensible
// shape and accepts strongly-typed Mongo Filter / UpdateFilter
// arguments so callers don't reach for the raw driver.
import type {
  Collection,
  Document,
  Filter,
  ObjectId as ObjectIdType,
  UpdateFilter,
} from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "auto_booking_queue";

export interface AutoBookingQueueDoc {
  _id?: ObjectIdType;
  shopId: number;
  status?: string;
  vin?: string;
  customerId?: string;
  vehicleId?: string;
  scheduledFor?: Date;
  attempts?: number;
  lastError?: string;
  createdAt?: Date;
  updatedAt?: Date;
  [extra: string]: unknown;
}

function toId(id: string | ObjectIdType): ObjectIdType {
  return typeof id === "string" ? new ObjectId(id) : id;
}

async function collection(): Promise<Collection<AutoBookingQueueDoc>> {
  const db = await getDb();
  return db.collection<AutoBookingQueueDoc>(COLLECTION);
}

export async function insertQueueItem(
  doc: Omit<AutoBookingQueueDoc, "_id">,
): Promise<ObjectIdType> {
  const col = await collection();
  const res = await col.insertOne(doc);
  return res.insertedId;
}

export async function findQueueItemById(
  id: string | ObjectIdType,
): Promise<AutoBookingQueueDoc | null> {
  const col = await collection();
  return col.findOne({ _id: toId(id) });
}

export async function findQueueItem(
  filter: Filter<AutoBookingQueueDoc>,
): Promise<AutoBookingQueueDoc | null> {
  const col = await collection();
  return col.findOne(filter);
}

export interface ListQueueOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
}

export async function listQueueItems(
  filter: Filter<AutoBookingQueueDoc>,
  opts: ListQueueOptions = {},
): Promise<AutoBookingQueueDoc[]> {
  const col = await collection();
  const cursor = col.find(filter);
  if (opts.sort) cursor.sort(opts.sort);
  if (opts.limit) cursor.limit(opts.limit);
  return cursor.toArray();
}

export async function countQueueItems(
  filter: Filter<AutoBookingQueueDoc>,
): Promise<number> {
  const col = await collection();
  return col.countDocuments(filter);
}

export async function updateQueueItem(
  filter: Filter<AutoBookingQueueDoc>,
  update: UpdateFilter<AutoBookingQueueDoc>,
): Promise<number> {
  const col = await collection();
  const res = await col.updateOne(filter, update);
  return res.modifiedCount;
}

export async function updateQueueItemById(
  id: string | ObjectIdType,
  update: UpdateFilter<AutoBookingQueueDoc>,
): Promise<number> {
  return updateQueueItem({ _id: toId(id) }, update);
}

export async function deleteQueueItem(
  filter: Filter<AutoBookingQueueDoc>,
): Promise<number> {
  const col = await collection();
  const res = await col.deleteOne(filter);
  return res.deletedCount;
}

export async function deleteQueueItems(
  filter: Filter<AutoBookingQueueDoc>,
): Promise<number> {
  const col = await collection();
  const res = await col.deleteMany(filter);
  return res.deletedCount;
}

export async function aggregateQueue<T = Document>(
  pipeline: Document[],
): Promise<T[]> {
  const col = await collection();
  return col.aggregate<T>(pipeline).toArray();
}
