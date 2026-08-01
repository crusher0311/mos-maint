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
import {
  isLegacyVehiclesPgCanonical,
  shouldShadowWriteMongoLegacyVehicles,
  shadowWriteMongoLegacyStore,
} from "@/lib/db/legacy-store-write-mode";
import * as pg from "./pg/pre-normalized";

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

/**
 * Insert a brand-new customer unconditionally. Every call MUST create a
 * distinct record — never selector-matched — so anonymous/no-identity
 * webhook payloads don't collapse onto an existing customer.
 */
export async function insertCustomer(
  doc: CustomerDoc,
): Promise<ObjectId | string> {
  if (isLegacyVehiclesPgCanonical()) {
    const id = await pg.insertCustomer(doc as Record<string, unknown>);
    if (shouldShadowWriteMongoLegacyVehicles()) {
      await shadowWriteMongoLegacyStore("customers.insert", async () => {
        const col = await collection();
        await col.insertOne(doc);
      });
    }
    return id;
  }
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

/* -------------------------------------------------------------------------- */
/* Gated named helpers (task #1000)                                            */
/*                                                                             */
/* The central AutoFlow-webhook upsert flow (lib/upsert-customer.ts and        */
/* lib/models/customers.ts) folds onto these. Each dispatches on               */
/* `isLegacyVehiclesPgCanonical()` (customers share the vehicles flag —        */
/* they migrate as one identity-store package): OFF (default) runs the Mongo   */
/* body verbatim; ON reads/writes Postgres and shadow-writes Mongo when the    */
/* shadow flag is still on. The generic Filter surface above stays Mongo-only  */
/* for the long-tail callers.                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Find a single customer's `_id` by an `$or` of selectors (mirrors the
 * models/customers lookup `findOne({ $or: selectors }, { _id: 1 })`).
 * Under PG-canonical the returned id is a synthetic string (the PG row id)
 * — callers only need a stable handle to feed subsequent upserts.
 */
export async function findCustomerIdBySelectors(
  selectors: Array<Record<string, unknown>>,
): Promise<{ _id: ObjectId | string } | null> {
  if (isLegacyVehiclesPgCanonical()) {
    for (const sel of selectors) {
      const found = await pg.findCustomerBySelector(sel);
      if (found) return { _id: String(found.id ?? "") };
    }
    return null;
  }
  const col = await collection();
  const doc = await col.findOne(
    { $or: selectors } as Filter<CustomerDoc>,
    { projection: { _id: 1 } },
  );
  return doc ? { _id: doc._id as ObjectId } : null;
}

/**
 * Upsert a customer identified by a Mongo-shaped `selector` object. Mirrors
 * `updateOne(selector, { $set, $setOnInsert }, { upsert: true })`. Returns
 * nothing — callers that need the id re-query via `findCustomerIdBySelectors`
 * (matching the existing Mongo flow).
 */
export async function upsertCustomerBySelector(
  selector: Record<string, unknown>,
  set: Record<string, unknown>,
  setOnInsert: Record<string, unknown> = {},
): Promise<void> {
  if (isLegacyVehiclesPgCanonical()) {
    const existing = await pg.findCustomerBySelector(selector);
    const base = existing
      ? { ...(existing.payload as Record<string, unknown>), ...set }
      : { ...setOnInsert, ...set };
    await pg.upsertCustomerBySelector(selector, base);
    if (shouldShadowWriteMongoLegacyVehicles()) {
      await shadowWriteMongoLegacyStore("customers.upsertBySelector", async () => {
        const col = await collection();
        await col.updateOne(
          selector as Filter<CustomerDoc>,
          { $set: set, $setOnInsert: setOnInsert } as UpdateFilter<CustomerDoc>,
          { upsert: true },
        );
      });
    }
    return;
  }
  const col = await collection();
  await col.updateOne(
    selector as Filter<CustomerDoc>,
    { $set: set, $setOnInsert: setOnInsert } as UpdateFilter<CustomerDoc>,
    { upsert: true },
  );
}

/**
 * Dashboard "open customers" read (used by
 * lib/models/customers.ts:getOpenCustomersForDashboard). Mirrors the Mongo
 * query: shopId in [String, Number] AND status NOT IN closedSet AND
 * vehicle.vin present, sorted by updatedAt desc, limited.
 */
export async function findOpenCustomersForDashboard(
  shopId: number | string,
  closedSet: readonly string[],
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  if (isLegacyVehiclesPgCanonical()) {
    return pg.findOpenCustomersForDashboard(shopId, closedSet, limit);
  }
  const col = await collection();
  const shopIdNum = Number(shopId);
  const shopIdStr = String(shopId);
  const cursor = col
    .find({
      $and: [
        { $or: [{ shopId: shopIdNum }, { shopId: shopIdStr }] },
        { status: { $nin: closedSet as unknown as string[] } },
        { "vehicle.vin": { $nin: ["", null] } },
      ],
    } as Filter<CustomerDoc>)
    .project({
      name: 1,
      status: 1,
      lastStatus: 1,
      lastTicketId: 1,
      updatedAt: 1,
      vehicle: { year: 1, make: 1, model: 1, vin: 1, odometer: 1, license: 1 },
    })
    .sort({ updatedAt: -1 })
    .limit(limit);
  return cursor.toArray() as unknown as Array<Record<string, unknown>>;
}

/**
 * Update a customer by its handle (Mongo `_id` string/ObjectId, or PG row
 * id). Mirrors `updateOne({ _id }, { $set, $setOnInsert })`.
 */
export async function updateCustomerByHandle(
  id: ObjectId | string,
  set: Record<string, unknown>,
  setOnInsert: Record<string, unknown> = {},
): Promise<void> {
  if (isLegacyVehiclesPgCanonical()) {
    await pg.updateCustomerById(String(id), { ...setOnInsert, ...set });
    if (shouldShadowWriteMongoLegacyVehicles()) {
      await shadowWriteMongoLegacyStore("customers.updateByHandle", async () => {
        const col = await collection();
        const _id = typeof id === "string" ? new ObjectId(id) : id;
        await col.updateOne(
          { _id } as Filter<CustomerDoc>,
          { $set: set, $setOnInsert: setOnInsert } as UpdateFilter<CustomerDoc>,
        );
      });
    }
    return;
  }
  const col = await collection();
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  await col.updateOne(
    { _id } as Filter<CustomerDoc>,
    { $set: set, $setOnInsert: setOnInsert } as UpdateFilter<CustomerDoc>,
  );
}
