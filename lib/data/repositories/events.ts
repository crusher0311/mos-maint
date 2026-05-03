// Repository for the `events` collection.
//
// `events` is the firehose where AutoFlow webhook payloads (and a
// handful of UI-emitted markers like `manual_closed`) land. Callers
// here only need a small handful of access patterns: append, count,
// list-recent, find-one for debugging, and a streaming cursor for the
// AutoFlow customer backfill script.
import type {
  Collection,
  Document,
  Filter,
  FindCursor,
  WithId,
} from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "events";

export interface EventDoc {
  provider?: string;
  event?: string;
  type?: string;
  shopId?: number | string;
  vehicleVin?: string;
  vin?: string;
  receivedAt?: Date;
  createdAt?: Date;
  payload?: Record<string, unknown>;
  [extra: string]: unknown;
}

async function collection(): Promise<Collection<EventDoc>> {
  const db = await getDb();
  return db.collection<EventDoc>(COLLECTION);
}

/**
 * Insert a single event row. Adds `createdAt = new Date()` only if
 * the caller hasn't supplied one — webhook handlers want to record
 * the wire-arrival time precisely.
 */
export async function insertEvent(doc: EventDoc): Promise<void> {
  const col = await collection();
  await col.insertOne({ createdAt: new Date(), ...doc });
}

export async function countEvents(
  filter: Filter<EventDoc>,
): Promise<number> {
  const col = await collection();
  return col.countDocuments(filter);
}

export async function findOneEvent(
  filter: Filter<EventDoc>,
): Promise<WithId<EventDoc> | null> {
  const col = await collection();
  return col.findOne(filter);
}

/**
 * List recent events matching a filter, optionally with a projection.
 * Sort defaults to newest-first by `receivedAt` because that's the
 * field the dashboard / list views care about; pass an explicit
 * `sort` when you need something else (e.g. the debug page that sorts
 * by `createdAt`).
 */
export async function listRecentEvents(
  filter: Filter<EventDoc>,
  options: {
    limit?: number;
    projection?: Record<string, 0 | 1>;
    sort?: Record<string, 1 | -1>;
  } = {},
): Promise<WithId<EventDoc>[]> {
  const col = await collection();
  const cursor = col.find(filter).sort(options.sort ?? { receivedAt: -1 });
  if (options.projection) cursor.project(options.projection);
  if (options.limit) cursor.limit(options.limit);
  return cursor.toArray();
}

/**
 * Stream events newest-first — used by the AutoFlow customer backfill
 * script which iterates the entire history and can't afford to load
 * the full result set into memory. Caller is responsible for closing
 * the cursor when finished (consuming with `hasNext`/`next` until
 * exhausted is fine).
 */
export async function streamEvents(
  filter: Filter<EventDoc>,
  sort: Record<string, 1 | -1> = { receivedAt: -1 },
): Promise<FindCursor<WithId<EventDoc>>> {
  const col = await collection();
  return col.find(filter).sort(sort);
}

/**
 * Aggregate over the events collection — keeps the door open for the
 * one-off analytics callers without forcing us to invent a named
 * function for every roll-up shape.
 */
export async function aggregateEvents<T = Document>(
  pipeline: Document[],
): Promise<T[]> {
  const col = await collection();
  return col.aggregate<T>(pipeline).toArray();
}
