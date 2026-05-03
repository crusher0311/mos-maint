// Repository for the `vehicles` collection.
//
// The vehicles collection is one of the largest in the system (every
// VIN we've ever seen via webhooks, manual entry, or extension).
// Callers vary a lot, so this surface stays generic on `Filter` /
// `UpdateFilter` rather than inventing a named function for every
// query shape.
import type {
  Collection,
  Document,
  Filter,
  UpdateFilter,
  WithId,
} from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "vehicles";

export interface VehicleDoc {
  vin?: string;
  shopId?: number | string;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  lastMileage?: number | null;
  declined?: unknown;
  components?: unknown;
  updatedAt?: Date;
  createdAt?: Date;
  [extra: string]: unknown;
}

async function collection(): Promise<Collection<VehicleDoc>> {
  const db = await getDb();
  return db.collection<VehicleDoc>(COLLECTION);
}

export async function findVehicle(
  filter: Filter<VehicleDoc>,
  projection?: Record<string, 0 | 1>,
): Promise<WithId<VehicleDoc> | null> {
  const col = await collection();
  return col.findOne(filter, projection ? { projection } : undefined);
}

export async function findVehicles(
  filter: Filter<VehicleDoc>,
  options: {
    sort?: Record<string, 1 | -1>;
    limit?: number;
    projection?: Record<string, 0 | 1>;
  } = {},
): Promise<WithId<VehicleDoc>[]> {
  const col = await collection();
  const cursor = col.find(filter);
  if (options.sort) cursor.sort(options.sort);
  if (options.projection) cursor.project(options.projection);
  if (options.limit) cursor.limit(options.limit);
  return cursor.toArray();
}

export async function countVehicles(
  filter: Filter<VehicleDoc>,
): Promise<number> {
  const col = await collection();
  return col.countDocuments(filter);
}

export async function updateVehicle(
  filter: Filter<VehicleDoc>,
  update: UpdateFilter<VehicleDoc>,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const col = await collection();
  const res = await col.updateOne(filter, update);
  return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
}

export async function upsertVehicle(
  filter: Filter<VehicleDoc>,
  update: UpdateFilter<VehicleDoc>,
): Promise<{ matchedCount: number; modifiedCount: number; upsertedId: unknown }> {
  const col = await collection();
  const res = await col.updateOne(filter, update, { upsert: true });
  return {
    matchedCount: res.matchedCount,
    modifiedCount: res.modifiedCount,
    upsertedId: res.upsertedId,
  };
}

export async function aggregateVehicles<T = Document>(
  pipeline: Document[],
): Promise<T[]> {
  const col = await collection();
  return col.aggregate<T>(pipeline).toArray();
}
