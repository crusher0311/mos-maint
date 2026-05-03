// Repository for the `customers` collection.
//
// Note: `lib/models/customers.ts` still owns the rich
// AutoFlow-webhook upsert flow that touches multiple collections
// (customers + vehicles + repair_orders). That function is migrated
// separately as part of the multi-collection batch. This repository
// is the narrow CRUD surface for callers that work only with the
// `customers` collection.
import type {
  Collection,
  Filter,
  FindCursor,
  UpdateFilter,
  WithId,
} from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "customers";

export interface CustomerDoc {
  _id?: ObjectId;
  shopId?: number | string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
  status?: string | null;
  provider?: string | null;
  openedAt?: Date;
  closedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string;
  lastVin?: string | null;
  lastRo?: string | number | null;
  lastMileage?: number | null;
  lastStatus?: string | null;
  lastTicketId?: string | number | null;
  vehicle?: Record<string, unknown>;
  [extra: string]: unknown;
}

async function collection(): Promise<Collection<CustomerDoc>> {
  const db = await getDb();
  return db.collection<CustomerDoc>(COLLECTION);
}

export async function insertCustomer(doc: CustomerDoc): Promise<ObjectId> {
  const col = await collection();
  const res = await col.insertOne(doc);
  return res.insertedId as ObjectId;
}

export async function findCustomerById(
  id: string | ObjectId,
  projection?: Record<string, 0 | 1>,
): Promise<WithId<CustomerDoc> | null> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const col = await collection();
  return col.findOne(
    { _id } as Filter<CustomerDoc>,
    projection ? { projection } : undefined,
  );
}

export async function updateCustomerById(
  id: string | ObjectId,
  filter: Filter<CustomerDoc>,
  update: UpdateFilter<CustomerDoc>,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const col = await collection();
  const res = await col.updateOne(
    { _id, ...filter } as Filter<CustomerDoc>,
    update,
  );
  return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
}

export async function findCustomers(
  filter: Filter<CustomerDoc>,
  options: {
    sort?: Record<string, 1 | -1>;
    limit?: number;
    projection?: Record<string, 0 | 1>;
  } = {},
): Promise<WithId<CustomerDoc>[]> {
  const col = await collection();
  const cursor = col.find(filter);
  if (options.sort) cursor.sort(options.sort);
  if (options.projection) cursor.project(options.projection);
  if (options.limit && options.limit > 0) cursor.limit(options.limit);
  return cursor.toArray();
}

export async function findCustomersCursor(
  filter: Filter<CustomerDoc>,
  options: {
    sort?: Record<string, 1 | -1>;
    projection?: Record<string, 0 | 1>;
  } = {},
): Promise<FindCursor<WithId<CustomerDoc>>> {
  const col = await collection();
  const cursor = col.find(filter);
  if (options.sort) cursor.sort(options.sort);
  if (options.projection) cursor.project(options.projection);
  return cursor;
}

export async function countCustomers(
  filter: Filter<CustomerDoc>,
): Promise<number> {
  const col = await collection();
  return col.countDocuments(filter);
}
