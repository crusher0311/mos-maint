// Repository for the `auto_booking_queue` collection.
//
// The queue document shape is loose and grows organically as new
// callers add fields (oil-change reminders, manual escalations,
// admin retries, etc.). The repository exposes a permissive
// document shape and accepts open-ended Mongo Filter / UpdateFilter
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

export interface AutoBookingQueueDoc extends Document {
  _id?: ObjectIdType;
  shopId: number;
  status?: string;
  vin?: string;
  customerId?: string;
  vehicleId?: string;
  scheduledDate?: string;
  scheduledTime?: string;
  serviceType?: string;
  serviceDueDate?: string;
  serviceMileage?: number;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  confirmationMode?: string;
  externalAppointmentId?: string;
  provider?: string;
  confirmedAt?: Date;
  sentAt?: Date;
  failedAt?: Date;
  failedReason?: string;
  stickerGeneratedAt?: Date;
  replacesBookingId?: string;
  previousExternalId?: string;
  previousScheduledDate?: string;
  supersededAt?: Date;
  attempts?: number;
  lastError?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

type QueueFilter = Filter<Document>;
type QueueUpdate = UpdateFilter<Document>;

function toId(id: string | ObjectIdType): ObjectIdType {
  return typeof id === "string" ? new ObjectId(id) : id;
}

async function collection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(COLLECTION);
}

export async function insertQueueItem(doc: Document): Promise<ObjectIdType> {
  const col = await collection();
  const res = await col.insertOne({ ...doc });
  return res.insertedId;
}

export async function findQueueItemById(
  id: string | ObjectIdType,
): Promise<AutoBookingQueueDoc | null> {
  const col = await collection();
  return (await col.findOne({ _id: toId(id) })) as AutoBookingQueueDoc | null;
}

export async function findQueueItem(
  filter: QueueFilter,
): Promise<AutoBookingQueueDoc | null> {
  const col = await collection();
  return (await col.findOne(filter)) as AutoBookingQueueDoc | null;
}

export interface ListQueueOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
}

export async function listQueueItems(
  filter: QueueFilter,
  opts: ListQueueOptions = {},
): Promise<AutoBookingQueueDoc[]> {
  const col = await collection();
  const cursor = col.find(filter);
  if (opts.sort) cursor.sort(opts.sort);
  if (opts.limit) cursor.limit(opts.limit);
  return (await cursor.toArray()) as AutoBookingQueueDoc[];
}

export async function countQueueItems(filter: QueueFilter): Promise<number> {
  const col = await collection();
  return col.countDocuments(filter);
}

export async function updateQueueItem(
  filter: QueueFilter,
  update: QueueUpdate,
): Promise<number> {
  const col = await collection();
  const res = await col.updateOne(filter, update);
  return res.modifiedCount;
}

export async function updateQueueItemById(
  id: string | ObjectIdType,
  update: QueueUpdate,
): Promise<number> {
  return updateQueueItem({ _id: toId(id) }, update);
}

export async function deleteQueueItem(filter: QueueFilter): Promise<number> {
  const col = await collection();
  const res = await col.deleteOne(filter);
  return res.deletedCount;
}

export async function deleteQueueItems(filter: QueueFilter): Promise<number> {
  const col = await collection();
  const res = await col.deleteMany(filter);
  return res.deletedCount;
}

export async function aggregateQueue<T extends Document = Document>(
  pipeline: Document[],
): Promise<T[]> {
  const col = await collection();
  return col.aggregate<T>(pipeline).toArray();
}

// --- Cross-collection lookups used by lib/auto-booking/scheduler.ts ----
//
// The scheduler resolves a queued booking back to the right SMS
// provider by reading from a few cache collections (Tekmetric repair
// orders / vehicles, Protractor vehicles / RO cache). These are not
// "queue" data per se, but the scheduler is the only caller, so we
// keep the helpers here rather than spawn a thin per-collection repo.

export interface TekmetricRepairOrderRef {
  data?: {
    customer?: { id?: number };
    vehicle?: { id?: number };
  };
}

export async function findTekmetricRepairOrderByVin(
  tekmetricShopId: number,
  vin: string,
): Promise<TekmetricRepairOrderRef | null> {
  const db = await getDb();
  return db.collection<TekmetricRepairOrderRef>("tekmetric_repair_orders").findOne({
    tekmetricShopId,
    "data.vehicle.vin": vin.toUpperCase(),
  } as Filter<TekmetricRepairOrderRef>);
}

export interface TekmetricVehicleRef {
  data?: {
    id?: number;
    customerId?: number;
  };
}

export async function findTekmetricVehicleByVin(
  tekmetricShopId: number,
  vin: string,
): Promise<TekmetricVehicleRef | null> {
  const db = await getDb();
  return db.collection<TekmetricVehicleRef>("tekmetric_vehicles").findOne({
    tekmetricShopId,
    "data.vin": vin.toUpperCase(),
  } as Filter<TekmetricVehicleRef>);
}

export interface ProtractorVehicleCacheRef {
  protractorId?: string | number;
  data?: {
    Owner?: { ID?: string | number };
  };
}

export async function findProtractorVehicleByVin(
  shopId: number,
  vin: string,
): Promise<ProtractorVehicleCacheRef | null> {
  const db = await getDb();
  return db.collection<ProtractorVehicleCacheRef>("protractor_vehicles").findOne({
    shopId,
    vin: vin.toUpperCase(),
  } as Filter<ProtractorVehicleCacheRef>);
}

export interface ProtractorRoCacheRef {
  data?: {
    ServiceItem?: { ID?: string | number; VIN?: string };
    Contact?: { ID?: string | number };
    DateOut?: string;
  };
}

export async function findLatestProtractorRoByVin(
  shopId: number,
  vin: string,
): Promise<ProtractorRoCacheRef | null> {
  const db = await getDb();
  return db
    .collection<ProtractorRoCacheRef>("protractor_ro_cache")
    .findOne(
      { shopId, "data.ServiceItem.VIN": vin.toUpperCase() } as Filter<ProtractorRoCacheRef>,
      { sort: { "data.DateOut": -1 } },
    );
}
