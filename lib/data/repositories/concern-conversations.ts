// Repository for the pre-normalized `concern_conversations` Mongo
// collection (task #1000).
//
// Concern-assistant chat threads written/read by the extension and
// dashboard concern-assistant routes. Every public helper is gated on
// `isConcernConversationsPgCanonical()`. When OFF (default), the original
// Mongo body runs verbatim (zero behaviour change). When ON, reads go to
// the Postgres mirror and writes go PG-first, then replay the Mongo write
// via `shadowWriteMongoLegacyStore` (only while the shadow flag is on).
//
// Shop-id keying is preserved exactly: docs carry a canonical `mosShopId`
// (int) and a legacy raw `shopId` (string|number|null); reads match on
// either, mirroring the Mongo `$or`.
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongo";
import {
  isConcernConversationsPgCanonical,
  shouldShadowWriteMongoConcernConversations,
  shadowWriteMongoLegacyStore,
} from "@/lib/db/legacy-store-write-mode";
import * as pg from "./pg/concern-conversations";

type AnyDoc = Record<string, unknown>;

const COLLECTION = "concern_conversations";

/* -------------------------------------------------------------------------- */
/* reads                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `findOne({ _id }, { projection: { roundResults: 1 } })`. Returns `null`
 * on a missing/malformed id (callers treat that as "no stored history").
 */
export async function findConversationRoundResults(
  conversationId: string,
): Promise<{ roundResults?: unknown } | null> {
  if (isConcernConversationsPgCanonical()) {
    return pg.findConversationRoundResults(conversationId);
  }
  const db = await getDb();
  const conv = await db.collection(COLLECTION).findOne(
    { _id: new ObjectId(conversationId) },
    { projection: { roundResults: 1 } },
  );
  return conv as { roundResults?: unknown } | null;
}

/**
 * `find({ userId, $or: [...] }).sort({ updatedAt: -1 }).limit(limit)`.
 * `mosShopId`/`rawShopId` are undefined when the caller passed no shopId.
 */
export async function findConversationsForUser(params: {
  userId: string;
  mosShopId?: number;
  rawShopId?: string | null;
  limit: number;
}): Promise<AnyDoc[]> {
  if (isConcernConversationsPgCanonical()) {
    return pg.findConversationsForUser(params);
  }
  const db = await getDb();
  const filter: AnyDoc = { userId: params.userId };
  if (params.mosShopId !== undefined || (params.rawShopId ?? null) !== null) {
    filter.$or = [
      { mosShopId: params.mosShopId },
      { mosShopId: String(params.mosShopId) },
      { shopId: params.rawShopId },
      { shopId: Number(params.rawShopId) },
    ];
  }
  return db
    .collection(COLLECTION)
    .find(filter)
    .sort({ updatedAt: -1 })
    .limit(params.limit)
    .toArray();
}

/* -------------------------------------------------------------------------- */
/* writes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `insertOne(doc)`; returns the new conversation id hex. When PG-canonical
 * the row is written to Postgres first (its generated id is authoritative),
 * then shadow-written to Mongo under the SAME id so both stores agree.
 */
export async function insertConversation(doc: AnyDoc): Promise<string> {
  if (isConcernConversationsPgCanonical()) {
    const id = await pg.insertConversation(doc);
    if (shouldShadowWriteMongoConcernConversations()) {
      await shadowWriteMongoLegacyStore("concern_conversations.insert", async () => {
        const db = await getDb();
        await db.collection(COLLECTION).insertOne({ ...doc, _id: new ObjectId(id) });
      });
    }
    return id;
  }
  const db = await getDb();
  const res = await db.collection(COLLECTION).insertOne(doc);
  return res.insertedId.toString();
}

/** `updateOne({ _id }, { $push: { roundResults: entry } })`. */
export async function pushRoundResults(
  conversationId: string,
  entry: unknown,
): Promise<void> {
  if (isConcernConversationsPgCanonical()) {
    await pg.pushRoundResults(conversationId, entry);
    if (shouldShadowWriteMongoConcernConversations()) {
      await shadowWriteMongoLegacyStore("concern_conversations.pushRoundResults", () =>
        pushRoundResultsMongo(conversationId, entry),
      );
    }
    return;
  }
  await pushRoundResultsMongo(conversationId, entry);
}

async function pushRoundResultsMongo(
  conversationId: string,
  entry: unknown,
): Promise<void> {
  const db = await getDb();
  await db.collection<{ roundResults?: unknown[] }>(COLLECTION).updateOne(
    { _id: new ObjectId(conversationId) },
    { $push: { roundResults: entry as { results: unknown[]; recordedAt: Date } } },
  );
}

/** `updateOne({ _id }, { $set: fields })`. */
export async function updateConversationSet(
  conversationId: string,
  fields: AnyDoc,
): Promise<void> {
  if (isConcernConversationsPgCanonical()) {
    await pg.updateConversationSet(conversationId, fields);
    if (shouldShadowWriteMongoConcernConversations()) {
      await shadowWriteMongoLegacyStore("concern_conversations.updateSet", () =>
        updateConversationSetMongo(conversationId, fields),
      );
    }
    return;
  }
  await updateConversationSetMongo(conversationId, fields);
}

async function updateConversationSetMongo(
  conversationId: string,
  fields: AnyDoc,
): Promise<void> {
  const db = await getDb();
  await db
    .collection(COLLECTION)
    .updateOne({ _id: new ObjectId(conversationId) }, { $set: fields });
}

/**
 * inject-protractor `updateMany`: tag a user's completed, not-yet-injected
 * conversations for a shop. Preserves the exact Mongo `$or` shop-keying.
 */
export async function markInjectedForUser(params: {
  userId: string;
  mosShopId: number;
  rawShopId: string | number;
  set: AnyDoc;
}): Promise<void> {
  if (isConcernConversationsPgCanonical()) {
    await pg.markInjectedForUser(params);
    if (shouldShadowWriteMongoConcernConversations()) {
      await shadowWriteMongoLegacyStore("concern_conversations.markInjected", () =>
        markInjectedForUserMongo(params),
      );
    }
    return;
  }
  await markInjectedForUserMongo(params);
}

async function markInjectedForUserMongo(params: {
  userId: string;
  mosShopId: number;
  rawShopId: string | number;
  set: AnyDoc;
}): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).updateMany(
    {
      userId: params.userId,
      status: "completed",
      injectedAt: { $exists: false },
      $or: [
        { mosShopId: params.mosShopId },
        { mosShopId: String(params.mosShopId) },
        { shopId: String(params.rawShopId) },
        { shopId: Number(params.rawShopId) },
        { shopId: null, mosShopId: { $exists: false } },
      ],
    },
    { $set: params.set },
  );
}
