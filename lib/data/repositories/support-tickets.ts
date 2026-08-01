// Repository for the `support_tickets` collection.
//
// Covers the small set of access patterns the support + platform-admin
// routes need: count, find-by-id, list (paginated), insert, update,
// updateMany (auto-close sweep), aggregate (status stats), and the
// $push-reply helper.
//
// Task #1000 (PACKAGE 4): every public helper is gated on
// `isSupportTicketsPgCanonical()`. When OFF (default), the original Mongo
// body runs verbatim (zero behaviour change). When ON, reads/writes go to
// the Postgres table (`./pg/support-tickets`) and writes replay the Mongo
// write via `shadowWriteMongoLegacyStore` when
// `shouldShadowWriteMongoSupportTickets()` is still on.
import type {
  Collection,
  Document,
  Filter,
  UpdateFilter,
  WithId,
} from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isSupportTicketsPgCanonical,
  shouldShadowWriteMongoSupportTickets,
  shadowWriteMongoLegacyStore,
} from "@/lib/db/legacy-store-write-mode";
import * as pg from "./pg/support-tickets";

const COLLECTION = "support_tickets";

export interface SupportTicketMessage {
  id: string;
  from: string;
  fromEmail?: string;
  fromName?: string;
  message: string;
  createdAt: Date;
}

export interface SupportTicketDoc {
  _id?: ObjectId;
  ticketNumber?: string;
  subject?: string;
  description?: string;
  category?: string;
  priority?: string;
  status?: string;
  userEmail?: string;
  userName?: string;
  shopId?: number | string | null;
  shopName?: string | null;
  locationIdentifier?: string | null;
  knowledgeArticleId?: string;
  resolvedAt?: Date | null;
  closedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  messages?: SupportTicketMessage[];
  [extra: string]: unknown;
}

async function collection(): Promise<Collection<SupportTicketDoc>> {
  const db = await getDb();
  return db.collection<SupportTicketDoc>(COLLECTION);
}

export async function countSupportTickets(
  filter: Filter<SupportTicketDoc> = {},
): Promise<number> {
  if (isSupportTicketsPgCanonical()) {
    return pg.countSupportTickets(filter);
  }
  return countSupportTicketsMongo(filter);
}

async function countSupportTicketsMongo(
  filter: Filter<SupportTicketDoc> = {},
): Promise<number> {
  const col = await collection();
  return col.countDocuments(filter);
}

export async function findSupportTicketById(
  id: string | ObjectId,
  extraFilter: Filter<SupportTicketDoc> = {},
): Promise<WithId<SupportTicketDoc> | null> {
  if (isSupportTicketsPgCanonical()) {
    return pg.findSupportTicketById(id, extraFilter);
  }
  return findSupportTicketByIdMongo(id, extraFilter);
}

async function findSupportTicketByIdMongo(
  id: string | ObjectId,
  extraFilter: Filter<SupportTicketDoc> = {},
): Promise<WithId<SupportTicketDoc> | null> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const col = await collection();
  return col.findOne({ _id, ...extraFilter } as Filter<SupportTicketDoc>);
}

export async function deleteSupportTicketById(
  id: string | ObjectId,
): Promise<{ deletedCount: number }> {
  if (isSupportTicketsPgCanonical()) {
    const res = await pg.deleteSupportTicketById(id);
    if (shouldShadowWriteMongoSupportTickets()) {
      await shadowWriteMongoLegacyStore("support_tickets.delete", () =>
        deleteSupportTicketByIdMongo(id),
      );
    }
    return res;
  }
  return deleteSupportTicketByIdMongo(id);
}

async function deleteSupportTicketByIdMongo(
  id: string | ObjectId,
): Promise<{ deletedCount: number }> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const col = await collection();
  const res = await col.deleteOne({ _id } as Filter<SupportTicketDoc>);
  return { deletedCount: res.deletedCount };
}

export async function listSupportTickets(
  filter: Filter<SupportTicketDoc> = {},
  options: {
    sort?: Record<string, 1 | -1>;
    skip?: number;
    limit?: number;
    projection?: Record<string, 0 | 1>;
  } = {},
): Promise<WithId<SupportTicketDoc>[]> {
  if (isSupportTicketsPgCanonical()) {
    return pg.listSupportTickets(filter, options);
  }
  return listSupportTicketsMongo(filter, options);
}

async function listSupportTicketsMongo(
  filter: Filter<SupportTicketDoc> = {},
  options: {
    sort?: Record<string, 1 | -1>;
    skip?: number;
    limit?: number;
    projection?: Record<string, 0 | 1>;
  } = {},
): Promise<WithId<SupportTicketDoc>[]> {
  const col = await collection();
  const cursor = col.find(filter);
  if (options.sort) cursor.sort(options.sort);
  if (options.projection) cursor.project(options.projection);
  if (options.skip) cursor.skip(options.skip);
  if (options.limit) cursor.limit(options.limit);
  return cursor.toArray();
}

export async function insertSupportTicket(
  doc: SupportTicketDoc,
): Promise<ObjectId> {
  if (isSupportTicketsPgCanonical()) {
    const insertedId = await pg.insertSupportTicket(doc);
    if (shouldShadowWriteMongoSupportTickets()) {
      // Preserve the PG-assigned id in the Mongo shadow doc so both stores
      // agree on the string id callers see.
      await shadowWriteMongoLegacyStore("support_tickets.insert", () =>
        insertSupportTicketMongo({ ...doc, _id: insertedId }),
      );
    }
    return insertedId;
  }
  return insertSupportTicketMongo(doc);
}

async function insertSupportTicketMongo(
  doc: SupportTicketDoc,
): Promise<ObjectId> {
  const col = await collection();
  const res = await col.insertOne(doc);
  return res.insertedId as ObjectId;
}

export async function updateSupportTicketById(
  id: string | ObjectId,
  update: UpdateFilter<SupportTicketDoc>,
  extraFilter: Filter<SupportTicketDoc> = {},
): Promise<{ matchedCount: number; modifiedCount: number }> {
  if (isSupportTicketsPgCanonical()) {
    const res = await pg.updateSupportTicketById(id, update, extraFilter);
    if (shouldShadowWriteMongoSupportTickets()) {
      await shadowWriteMongoLegacyStore("support_tickets.update", () =>
        updateSupportTicketByIdMongo(id, update, extraFilter),
      );
    }
    return res;
  }
  return updateSupportTicketByIdMongo(id, update, extraFilter);
}

async function updateSupportTicketByIdMongo(
  id: string | ObjectId,
  update: UpdateFilter<SupportTicketDoc>,
  extraFilter: Filter<SupportTicketDoc> = {},
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const col = await collection();
  const res = await col.updateOne(
    { _id, ...extraFilter } as Filter<SupportTicketDoc>,
    update,
  );
  return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
}

export async function findOneAndUpdateSupportTicketById(
  id: string | ObjectId,
  update: UpdateFilter<SupportTicketDoc>,
  extraFilter: Filter<SupportTicketDoc> = {},
): Promise<WithId<SupportTicketDoc> | null> {
  if (isSupportTicketsPgCanonical()) {
    const res = await pg.findOneAndUpdateSupportTicketById(
      id,
      update,
      extraFilter,
    );
    if (shouldShadowWriteMongoSupportTickets()) {
      await shadowWriteMongoLegacyStore(
        "support_tickets.findOneAndUpdate",
        () => findOneAndUpdateSupportTicketByIdMongo(id, update, extraFilter),
      );
    }
    return res;
  }
  return findOneAndUpdateSupportTicketByIdMongo(id, update, extraFilter);
}

async function findOneAndUpdateSupportTicketByIdMongo(
  id: string | ObjectId,
  update: UpdateFilter<SupportTicketDoc>,
  extraFilter: Filter<SupportTicketDoc> = {},
): Promise<WithId<SupportTicketDoc> | null> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const col = await collection();
  return col.findOneAndUpdate(
    { _id, ...extraFilter } as Filter<SupportTicketDoc>,
    update,
    { returnDocument: "after" },
  ) as Promise<WithId<SupportTicketDoc> | null>;
}

export async function updateManySupportTickets(
  filter: Filter<SupportTicketDoc>,
  update: UpdateFilter<SupportTicketDoc>,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  if (isSupportTicketsPgCanonical()) {
    const res = await pg.updateManySupportTickets(filter, update);
    if (shouldShadowWriteMongoSupportTickets()) {
      await shadowWriteMongoLegacyStore("support_tickets.updateMany", () =>
        updateManySupportTicketsMongo(filter, update),
      );
    }
    return res;
  }
  return updateManySupportTicketsMongo(filter, update);
}

async function updateManySupportTicketsMongo(
  filter: Filter<SupportTicketDoc>,
  update: UpdateFilter<SupportTicketDoc>,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const col = await collection();
  const res = await col.updateMany(filter, update);
  return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
}

export async function aggregateSupportTickets<T = Document>(
  pipeline: Document[],
): Promise<T[]> {
  if (isSupportTicketsPgCanonical()) {
    return pg.aggregateSupportTickets<T>(pipeline);
  }
  return aggregateSupportTicketsMongo<T>(pipeline);
}

async function aggregateSupportTicketsMongo<T = Document>(
  pipeline: Document[],
): Promise<T[]> {
  const col = await collection();
  return col.aggregate<T>(pipeline).toArray();
}
