/**
 * Postgres-backed repository for the pre-normalized `concern_conversations`
 * Mongo collection (task #1000).
 *
 * Used by `lib/data/repositories/concern-conversations.ts` when
 * `CONCERN_CONVERSATIONS_PG_CANONICAL=1`. The concern-assistant doc is
 * heterogeneous across surfaces (extension vs dashboard) and grows fields
 * over time (`userId`, `vehicleDisplay`, `exchanges`, `status`, `source`,
 * `cleanedText`, `injectedAt`/`injectedTo`/`injectedWorkOrderId`, …), so the
 * full doc is stored verbatim in the `payload` jsonb; the typed columns are
 * denormalised copies that back the indexed lookups.
 *
 * The `id` column mirrors the Mongo ObjectId hex string so callers keep
 * getting a valid `conversationId` back. New inserts generate a fresh
 * ObjectId hex.
 *
 * Shop-id keying is preserved exactly: the Mongo docs carry both a canonical
 * `mosShopId` (int) and a legacy raw `shopId` (string|number|null). Reads
 * match on either, mirroring the Mongo `$or`.
 *
 * The PG-vs-Mongo dispatcher lives in the Mongo repo — this file has no
 * knowledge of the kill-switch flag.
 */
import { ObjectId } from "mongodb";
import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { concernConversations } from "@/lib/db/schema/wave2";

type AnyDoc = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* doc <-> row                                                                 */
/* -------------------------------------------------------------------------- */

function toShopIdInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reconstruct the Mongo doc shape from a PG row. The full doc lives in
 * `payload`; `_id` is set from the row id so callers that read
 * `doc._id.toString()` keep working.
 */
function reconstructDoc(row: { id: string; payload: unknown }): AnyDoc {
  const payload = (row.payload as AnyDoc) ?? {};
  const doc: AnyDoc = { ...payload };
  if (ObjectId.isValid(row.id)) {
    doc._id = new ObjectId(row.id);
  } else {
    doc._id = row.id;
  }
  return doc;
}

/** Pull the indexed typed columns out of a full doc. */
function typedColumns(doc: AnyDoc): AnyDoc {
  return {
    shopId: toShopIdInt(doc.mosShopId) ?? toShopIdInt(doc.shopId) ?? 0,
    mosShopId: toShopIdInt(doc.mosShopId),
    vin: (doc.vin as string | null) ?? null,
    userId: doc.userId === null || doc.userId === undefined ? null : String(doc.userId),
    concern: (doc.concern as string | null) ?? null,
    symptomCategory: (doc.symptomCategory as string | null) ?? null,
    status: (doc.status as string | null) ?? null,
    injectedToProtractor: doc.injectedTo === "protractor" || doc.injectedToProtractor === true,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt : new Date(),
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date(),
  };
}

/* -------------------------------------------------------------------------- */
/* reads                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Returns the stored `roundResults` for a conversation (the Mongo
 * `findOne({ _id }, { projection: { roundResults: 1 } })`). Returns `null`
 * when the conversation is missing or the id is malformed.
 */
export async function findConversationRoundResults(
  conversationId: string,
): Promise<{ roundResults?: unknown } | null> {
  if (!ObjectId.isValid(conversationId)) return null;
  const db = getDb();
  const rows = await db
    .select({ payload: concernConversations.payload })
    .from(concernConversations)
    .where(eq(concernConversations.id, conversationId))
    .limit(1);
  if (!rows.length) return null;
  const payload = (rows[0].payload as AnyDoc) ?? {};
  return { roundResults: payload.roundResults };
}

/**
 * List a user's conversations, newest first. `mosShopId`/`rawShopId` mirror
 * the Mongo `$or` on `mosShopId` (int) and legacy `shopId` (raw). When both
 * are undefined, only the `userId` filter applies.
 */
export async function findConversationsForUser(params: {
  userId: string;
  mosShopId?: number;
  rawShopId?: string | null;
  limit: number;
}): Promise<AnyDoc[]> {
  const db = getDb();
  const clauses: SQL[] = [eq(concernConversations.userId, params.userId)];

  const shopClauses: SQL[] = [];
  if (params.mosShopId !== undefined && params.mosShopId !== null) {
    shopClauses.push(eq(concernConversations.mosShopId, params.mosShopId));
  }
  const rawInt = toShopIdInt(params.rawShopId);
  if (rawInt !== null) {
    // legacy raw shopId lived in the payload; match it there too
    shopClauses.push(
      sql`(${concernConversations.payload} #>> '{shopId}') = ${String(params.rawShopId)}`,
    );
    shopClauses.push(eq(concernConversations.mosShopId, rawInt));
  }
  if (shopClauses.length) {
    clauses.push(or(...shopClauses) as SQL);
  }

  const rows = await db
    .select({ id: concernConversations.id, payload: concernConversations.payload })
    .from(concernConversations)
    .where(and(...clauses))
    .orderBy(desc(concernConversations.updatedAt))
    .limit(params.limit);
  return rows.map(reconstructDoc);
}

/* -------------------------------------------------------------------------- */
/* writes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Insert a new conversation. Returns the generated ObjectId hex string that
 * callers hand back to the client as `conversationId`.
 */
export async function insertConversation(doc: AnyDoc): Promise<string> {
  const db = getDb();
  const id = new ObjectId().toString();
  const cols = typedColumns(doc);
  const fullPayload: AnyDoc = { ...doc, _id: id };
  await db.insert(concernConversations).values({
    id,
    ...cols,
    payload: fullPayload,
  } as typeof concernConversations.$inferInsert);
  return id;
}

/**
 * Mirror of `updateOne({ _id }, { $push: { roundResults: entry } })`.
 * No-op when the conversation is missing or the id is malformed.
 */
export async function pushRoundResults(
  conversationId: string,
  entry: unknown,
): Promise<void> {
  if (!ObjectId.isValid(conversationId)) return;
  const db = getDb();
  await db
    .update(concernConversations)
    .set({
      payload: sql`jsonb_set(
        coalesce(${concernConversations.payload}, '{}'::jsonb),
        '{roundResults}',
        coalesce(${concernConversations.payload} #> '{roundResults}', '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb
      )`,
    })
    .where(eq(concernConversations.id, conversationId));
}

/**
 * Mirror of `updateOne({ _id }, { $set: fields })`. Merges `fields` into the
 * payload jsonb and keeps the indexed typed columns in sync for the keys we
 * track. No-op when the id is malformed.
 */
export async function updateConversationSet(
  conversationId: string,
  fields: AnyDoc,
): Promise<void> {
  if (!ObjectId.isValid(conversationId)) return;
  const db = getDb();

  const typedSet: AnyDoc = {};
  if ("status" in fields) typedSet.status = (fields.status as string | null) ?? null;
  if ("symptomCategory" in fields)
    typedSet.symptomCategory = (fields.symptomCategory as string | null) ?? null;
  if ("vin" in fields) typedSet.vin = (fields.vin as string | null) ?? null;
  if ("updatedAt" in fields && fields.updatedAt instanceof Date)
    typedSet.updatedAt = fields.updatedAt;
  if (fields.injectedTo === "protractor") typedSet.injectedToProtractor = true;

  await db
    .update(concernConversations)
    .set({
      ...typedSet,
      payload: sql`coalesce(${concernConversations.payload}, '{}'::jsonb) || ${JSON.stringify(fields)}::jsonb`,
    } as Partial<typeof concernConversations.$inferInsert>)
    .where(eq(concernConversations.id, conversationId));
}

/**
 * Mirror of the inject-protractor `updateMany` that tags a user's completed,
 * not-yet-injected conversations for the shop. The Mongo `$or` matches the
 * canonical `mosShopId` (int) or the legacy raw `shopId`; the
 * `{ shopId: null, mosShopId: { $exists: false } }` variant is preserved as
 * "no shop key at all". Only rows where `payload.injectedAt` is absent are
 * touched.
 */
export async function markInjectedForUser(params: {
  userId: string;
  mosShopId: number;
  rawShopId: string | number;
  set: AnyDoc;
}): Promise<void> {
  const db = getDb();
  const rawStr = String(params.rawShopId);

  const shopMatch = or(
    eq(concernConversations.mosShopId, params.mosShopId),
    sql`(${concernConversations.payload} #>> '{shopId}') = ${rawStr}`,
    sql`(${concernConversations.payload} #>> '{shopId}') IS NULL AND (${concernConversations.payload} ? 'mosShopId') = false`,
  );

  await db
    .update(concernConversations)
    .set({
      payload: sql`coalesce(${concernConversations.payload}, '{}'::jsonb) || ${JSON.stringify(params.set)}::jsonb`,
      injectedToProtractor: params.set.injectedTo === "protractor" ? true : undefined,
    } as Partial<typeof concernConversations.$inferInsert>)
    .where(
      and(
        eq(concernConversations.userId, params.userId),
        eq(concernConversations.status, "completed"),
        sql`(${concernConversations.payload} ? 'injectedAt') = false`,
        shopMatch as SQL,
      ),
    );
}
