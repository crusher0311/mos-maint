/**
 * Postgres-backed `support_tickets` repository — the read & write surface
 * used by `lib/data/repositories/support-tickets.ts` when
 * `SUPPORT_TICKETS_PG_CANONICAL=1` (task #1000, PACKAGE 4).
 *
 * Backs the `support_tickets` table (lib/db/schema/support-tickets.ts).
 *
 * Identity bridge: the legacy Mongo repo hands callers ObjectId **string**
 * ids and callers guard with `ObjectId.isValid(...)`. To keep that contract
 * we store the string id in the `mongo_id` text column and reconstruct the
 * Mongo doc shape as `{ _id, ...columns, messages, ...metadata }`. Rows
 * backfilled from Mongo carry their original `_id` hex; tickets created here
 * get a freshly generated ObjectId-shaped hex (via `new ObjectId()`), so the
 * string-id contract holds for PG-native tickets too.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call site —
 * this file has no knowledge of the kill-switch flag.
 */
import type { Document, Filter, UpdateFilter, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import { and, asc, desc, eq, inArray, lt, or, sql, SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { supportTickets } from "@/lib/db/schema/support-tickets";
import type {
  SupportTicketDoc,
  SupportTicketMessage,
} from "@/lib/data/repositories/support-tickets";

type Row = typeof supportTickets.$inferSelect;

const VALID_CATEGORIES = [
  "technical",
  "billing",
  "integration",
  "feature_request",
  "general",
] as const;
const VALID_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const VALID_STATUSES = [
  "open",
  "in_progress",
  "pending",
  "resolved",
  "closed",
] as const;

function coerceCategory(v: unknown): (typeof VALID_CATEGORIES)[number] {
  return VALID_CATEGORIES.includes(v as never)
    ? (v as (typeof VALID_CATEGORIES)[number])
    : "general";
}
function coercePriority(v: unknown): (typeof VALID_PRIORITIES)[number] {
  return VALID_PRIORITIES.includes(v as never)
    ? (v as (typeof VALID_PRIORITIES)[number])
    : "medium";
}
function coerceStatus(v: unknown): (typeof VALID_STATUSES)[number] {
  return VALID_STATUSES.includes(v as never)
    ? (v as (typeof VALID_STATUSES)[number])
    : "open";
}

/* -------------------------------------------------------------------------- */
/* doc <-> row                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Reconstruct the Mongo doc shape from a PG row. The `metadata` jsonb carries
 * any extra fields (`assignedTo`, `resolvedBy`, `resolutionNotes`,
 * `knowledgeArticleId`, `escalatedFromChat`, `callerPhone`, …) that the loose
 * `SupportTicketDoc` index signature allowed on the Mongo side.
 */
function rowToDoc(row: Row): WithId<SupportTicketDoc> {
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  const idHex =
    row.mongoId && ObjectId.isValid(row.mongoId)
      ? row.mongoId
      : deriveObjectIdHex(row.id);
  const doc: SupportTicketDoc = {
    _id: new ObjectId(idHex),
    ticketNumber: row.ticketNumber ?? undefined,
    subject: row.subject ?? undefined,
    description: row.description ?? undefined,
    category: row.category ?? undefined,
    priority: row.priority ?? undefined,
    status: row.status ?? undefined,
    source: row.source ?? undefined,
    shopId: row.shopId ?? null,
    shopName: row.shopName ?? null,
    locationIdentifier: row.locationIdentifier ?? null,
    userEmail: row.userEmail ?? undefined,
    userName: row.userName ?? undefined,
    assignedTo: row.assignedTo ?? undefined,
    resolvedAt: row.resolvedAt ?? null,
    closedAt: row.closedAt ?? null,
    autoClosedAt: row.autoClosedAt ?? null,
    createdAt: row.createdAt ?? undefined,
    updatedAt: row.updatedAt ?? undefined,
    messages: (row.messages as SupportTicketMessage[] | null) ?? [],
    ...meta,
  } as SupportTicketDoc;
  return doc as WithId<SupportTicketDoc>;
}

/**
 * Deterministic 24-char hex fallback for legacy rows that predate the
 * `mongo_id` bridge (should not happen post-backfill, but keeps
 * `ObjectId.isValid` guards from throwing). Encodes the serial id.
 */
function deriveObjectIdHex(id: number): string {
  return id.toString(16).padStart(24, "0");
}

/** Columns/metadata split for an insert/update doc. */
const KNOWN_COLUMN_KEYS = new Set([
  "_id",
  "ticketNumber",
  "subject",
  "description",
  "category",
  "priority",
  "status",
  "source",
  "shopId",
  "shopName",
  "locationIdentifier",
  "userEmail",
  "userName",
  "resolvedAt",
  "closedAt",
  "autoClosedAt",
  "createdAt",
  "updatedAt",
  "messages",
  "assignedTo",
]);

function splitMetadata(doc: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!KNOWN_COLUMN_KEYS.has(k) && v !== undefined) meta[k] = v;
  }
  return meta;
}

/* -------------------------------------------------------------------------- */
/* Mongo filter -> Drizzle SQL                                                 */
/* -------------------------------------------------------------------------- */

const COLUMN_BY_KEY: Record<string, SQL.Aliased | any> = {
  ticketNumber: supportTickets.ticketNumber,
  subject: supportTickets.subject,
  description: supportTickets.description,
  category: supportTickets.category,
  priority: supportTickets.priority,
  status: supportTickets.status,
  source: supportTickets.source,
  shopId: supportTickets.shopId,
  shopName: supportTickets.shopName,
  locationIdentifier: supportTickets.locationIdentifier,
  userEmail: supportTickets.userEmail,
  userName: supportTickets.userName,
  assignedTo: supportTickets.assignedTo,
  resolvedAt: supportTickets.resolvedAt,
  closedAt: supportTickets.closedAt,
  updatedAt: supportTickets.updatedAt,
  createdAt: supportTickets.createdAt,
};

/**
 * Translate the narrow subset of Mongo filter operators the callers actually
 * use (`$in`, `$gte`, `$lt`, `$regex`/`$options: "i"`, and top-level `$or`)
 * into a Drizzle predicate. Unknown-column equality falls back to a metadata
 * jsonb text match so loose filters still work.
 */
function buildWhere(filter: Filter<SupportTicketDoc>): SQL | undefined {
  const clauses: SQL[] = [];
  for (const [key, raw] of Object.entries(filter)) {
    if (key === "$or" && Array.isArray(raw)) {
      const ors = raw
        .map((sub) => buildWhere(sub as Filter<SupportTicketDoc>))
        .filter((c): c is SQL => Boolean(c));
      if (ors.length) clauses.push(or(...ors) as SQL);
      continue;
    }
    if (key === "$and" && Array.isArray(raw)) {
      const ands = raw
        .map((sub) => buildWhere(sub as Filter<SupportTicketDoc>))
        .filter((c): c is SQL => Boolean(c));
      if (ands.length) clauses.push(and(...ands) as SQL);
      continue;
    }
    const clause = buildFieldClause(key, raw);
    if (clause) clauses.push(clause);
  }
  if (!clauses.length) return undefined;
  return clauses.length === 1 ? clauses[0] : (and(...clauses) as SQL);
}

function buildFieldClause(key: string, raw: unknown): SQL | undefined {
  const col = COLUMN_BY_KEY[key];

  if (raw !== null && typeof raw === "object" && !(raw instanceof Date)) {
    const ops = raw as Record<string, unknown>;
    const parts: SQL[] = [];
    if ("$in" in ops && Array.isArray(ops.$in)) {
      if (col) parts.push(inArray(col, ops.$in as unknown[]));
    }
    if ("$gte" in ops) {
      if (col) parts.push(sql`${col} >= ${ops.$gte}`);
    }
    if ("$gt" in ops) {
      if (col) parts.push(sql`${col} > ${ops.$gt}`);
    }
    if ("$lte" in ops) {
      if (col) parts.push(sql`${col} <= ${ops.$lte}`);
    }
    if ("$lt" in ops) {
      if (col) parts.push(sql`${col} < ${ops.$lt}`);
    }
    if ("$ne" in ops) {
      if (col) parts.push(sql`${col} <> ${ops.$ne}`);
    }
    if ("$regex" in ops && col) {
      // Callers always pass `$options: "i"`; use ILIKE with the pattern
      // treated as a substring (Mongo $regex here is a plain substring).
      const pattern = `%${String(ops.$regex)}%`;
      parts.push(sql`${col} ILIKE ${pattern}`);
    }
    if (!parts.length) return undefined;
    return parts.length === 1 ? parts[0] : (and(...parts) as SQL);
  }

  // Scalar equality.
  if (key === "shopId") {
    const n = raw == null ? null : Number(raw);
    return n == null || Number.isNaN(n)
      ? sql`${supportTickets.shopId} IS NULL`
      : eq(supportTickets.shopId, n);
  }
  if (col) return eq(col, raw as never);
  // Unknown column -> metadata text match.
  return sql`(${supportTickets.metadata} ->> ${key}) = ${String(raw)}`;
}

function idClause(id: string | ObjectId): SQL {
  const hex = typeof id === "string" ? id : id.toHexString();
  return eq(supportTickets.mongoId, hex);
}

/* -------------------------------------------------------------------------- */
/* operations                                                                  */
/* -------------------------------------------------------------------------- */

export async function countSupportTickets(
  filter: Filter<SupportTicketDoc> = {},
): Promise<number> {
  const db = getDb();
  const where = buildWhere(filter);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(supportTickets)
    .where(where ?? sql`true`);
  return rows[0]?.count ?? 0;
}

export async function findSupportTicketById(
  id: string | ObjectId,
  extraFilter: Filter<SupportTicketDoc> = {},
): Promise<WithId<SupportTicketDoc> | null> {
  const db = getDb();
  const extra = buildWhere(extraFilter);
  const where = extra ? and(idClause(id), extra) : idClause(id);
  const rows = await db
    .select()
    .from(supportTickets)
    .where(where as SQL)
    .limit(1);
  return rows.length ? rowToDoc(rows[0]) : null;
}

export async function deleteSupportTicketById(
  id: string | ObjectId,
): Promise<{ deletedCount: number }> {
  const db = getDb();
  const res = await db
    .delete(supportTickets)
    .where(idClause(id))
    .returning({ id: supportTickets.id });
  return { deletedCount: res.length };
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
  const db = getDb();
  const where = buildWhere(filter);
  let q = db
    .select()
    .from(supportTickets)
    .where(where ?? sql`true`)
    .$dynamic();

  if (options.sort) {
    const orderBys: SQL[] = [];
    for (const [key, dir] of Object.entries(options.sort)) {
      const col = COLUMN_BY_KEY[key];
      if (col) orderBys.push((dir === -1 ? desc(col) : asc(col)) as SQL);
    }
    if (orderBys.length) q = q.orderBy(...orderBys);
  }
  if (options.limit) q = q.limit(options.limit);
  if (options.skip) q = q.offset(options.skip);

  const rows = await q;
  // Projection is honoured by callers loosely; return full docs (the Mongo
  // repo's projection was only ever used for shop-id shaping which callers
  // read from the full doc anyway).
  return rows.map(rowToDoc);
}

export async function insertSupportTicket(
  doc: SupportTicketDoc,
): Promise<ObjectId> {
  const db = getDb();
  const oid =
    doc._id instanceof ObjectId
      ? doc._id
      : typeof doc._id === "string" && ObjectId.isValid(doc._id)
        ? new ObjectId(doc._id)
        : new ObjectId();
  const hex = oid.toHexString();
  const metadata = splitMetadata(doc as Record<string, unknown>);

  await db
    .insert(supportTickets)
    .values({
      mongoId: hex,
      ticketNumber: doc.ticketNumber ?? hex,
      subject: doc.subject ?? "",
      description: doc.description ?? "",
      category: coerceCategory(doc.category),
      priority: coercePriority(doc.priority),
      status: coerceStatus(doc.status),
      source: (doc.source as string | undefined) ?? "web",
      shopId: doc.shopId != null ? Number(doc.shopId) : null,
      shopName: (doc.shopName as string | null) ?? null,
      locationIdentifier: (doc.locationIdentifier as string | null) ?? null,
      userEmail: (doc.userEmail as string | undefined) ?? null,
      userName: (doc.userName as string | undefined) ?? null,
      assignedTo: (doc.assignedTo as string | undefined) ?? null,
      resolvedAt: (doc.resolvedAt as Date | null) ?? null,
      closedAt: (doc.closedAt as Date | null) ?? null,
      autoClosedAt: (doc.autoClosedAt as Date | undefined) ?? null,
      messages: (doc.messages as SupportTicketMessage[] | undefined) ?? [],
      metadata: Object.keys(metadata).length ? metadata : null,
      createdAt: (doc.createdAt as Date | undefined) ?? new Date(),
      updatedAt: (doc.updatedAt as Date | undefined) ?? new Date(),
    } as typeof supportTickets.$inferInsert)
    // The support-ticket POST route already performs a PG-first insert keyed
    // on the unique `ticket_number`; avoid a duplicate-key error by merging
    // our identity/columns onto the existing row instead of failing.
    .onConflictDoUpdate({
      target: supportTickets.ticketNumber,
      set: {
        mongoId: hex,
        messages:
          (doc.messages as SupportTicketMessage[] | undefined) ?? [],
        metadata: Object.keys(metadata).length ? metadata : null,
        updatedAt: (doc.updatedAt as Date | undefined) ?? new Date(),
      } as Partial<typeof supportTickets.$inferInsert>,
    });

  return oid;
}

/**
 * Apply a Mongo-style `$set` update (and merge extra top-level scalar fields
 * treated as `$set`) to the PG columns / metadata jsonb.
 */
function applyUpdate(
  update: UpdateFilter<SupportTicketDoc>,
  existingMeta: Record<string, unknown>,
): { columns: Record<string, unknown>; metadata: Record<string, unknown> } {
  const set =
    (update.$set as Record<string, unknown> | undefined) ??
    // A raw doc (no operators) is treated as a full $set by callers? None do
    // this today, but be defensive.
    (Object.keys(update).some((k) => k.startsWith("$"))
      ? {}
      : (update as Record<string, unknown>));

  const columns: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = { ...existingMeta };

  for (const [k, v] of Object.entries(set)) {
    if (k === "category") columns.category = coerceCategory(v);
    else if (k === "priority") columns.priority = coercePriority(v);
    else if (k === "status") columns.status = coerceStatus(v);
    else if (k === "shopId") columns.shopId = v != null ? Number(v) : null;
    else if (KNOWN_COLUMN_KEYS.has(k) && k !== "_id" && k !== "messages")
      columns[k] = v;
    else if (k !== "_id" && k !== "messages") metadata[k] = v;
  }

  return { columns, metadata };
}

export async function updateSupportTicketById(
  id: string | ObjectId,
  update: UpdateFilter<SupportTicketDoc>,
  extraFilter: Filter<SupportTicketDoc> = {},
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const db = getDb();
  const extra = buildWhere(extraFilter);
  const where = extra ? and(idClause(id), extra) : idClause(id);

  const existing = await db
    .select()
    .from(supportTickets)
    .where(where as SQL)
    .limit(1);
  if (!existing.length) return { matchedCount: 0, modifiedCount: 0 };

  const row = existing[0];
  const existingMeta =
    (row.metadata as Record<string, unknown> | null) ?? {};
  const { columns, metadata } = applyUpdate(update, existingMeta);

  const pushMessages = extractPush(update, row);

  await db
    .update(supportTickets)
    .set({
      ...columns,
      ...(pushMessages ? { messages: pushMessages } : {}),
      metadata: Object.keys(metadata).length ? metadata : null,
    } as Partial<typeof supportTickets.$inferInsert>)
    .where(where as SQL);

  return { matchedCount: 1, modifiedCount: 1 };
}

export async function findOneAndUpdateSupportTicketById(
  id: string | ObjectId,
  update: UpdateFilter<SupportTicketDoc>,
  extraFilter: Filter<SupportTicketDoc> = {},
): Promise<WithId<SupportTicketDoc> | null> {
  const db = getDb();
  const extra = buildWhere(extraFilter);
  const where = extra ? and(idClause(id), extra) : idClause(id);

  const existing = await db
    .select()
    .from(supportTickets)
    .where(where as SQL)
    .limit(1);
  if (!existing.length) return null;

  const row = existing[0];
  const existingMeta =
    (row.metadata as Record<string, unknown> | null) ?? {};
  const { columns, metadata } = applyUpdate(update, existingMeta);
  const pushMessages = extractPush(update, row);

  const updated = await db
    .update(supportTickets)
    .set({
      ...columns,
      ...(pushMessages ? { messages: pushMessages } : {}),
      metadata: Object.keys(metadata).length ? metadata : null,
    } as Partial<typeof supportTickets.$inferInsert>)
    .where(where as SQL)
    .returning();

  return updated.length ? rowToDoc(updated[0]) : null;
}

/** Handle `$push: { messages: <msg> }` by appending to the existing array. */
function extractPush(
  update: UpdateFilter<SupportTicketDoc>,
  row: Row,
): SupportTicketMessage[] | null {
  const push = update.$push as Record<string, unknown> | undefined;
  if (!push || !("messages" in push)) return null;
  const current = (row.messages as SupportTicketMessage[] | null) ?? [];
  const added = push.messages;
  const toAdd =
    added && typeof added === "object" && "$each" in (added as object)
      ? ((added as { $each: SupportTicketMessage[] }).$each ?? [])
      : [added as SupportTicketMessage];
  return [...current, ...toAdd];
}

export async function updateManySupportTickets(
  filter: Filter<SupportTicketDoc>,
  update: UpdateFilter<SupportTicketDoc>,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const db = getDb();
  const where = buildWhere(filter);

  // updateMany today is only the auto-close sweep ($set of scalar columns,
  // no $push). Apply the $set columns directly to matching rows.
  const set = (update.$set as Record<string, unknown> | undefined) ?? {};
  const columns: Record<string, unknown> = {};
  const metadataSet: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(set)) {
    if (k === "category") columns.category = coerceCategory(v);
    else if (k === "priority") columns.priority = coercePriority(v);
    else if (k === "status") columns.status = coerceStatus(v);
    else if (k === "shopId") columns.shopId = v != null ? Number(v) : null;
    else if (KNOWN_COLUMN_KEYS.has(k) && k !== "_id" && k !== "messages")
      columns[k] = v;
    else if (k !== "_id" && k !== "messages") metadataSet[k] = v;
  }

  const setClause: Record<string, unknown> = { ...columns };
  // Merge any unknown metadata keys into the existing metadata jsonb.
  if (Object.keys(metadataSet).length) {
    setClause.metadata = sql`coalesce(${supportTickets.metadata}, '{}'::jsonb) || ${JSON.stringify(
      metadataSet,
    )}::jsonb`;
  }

  const res = await db
    .update(supportTickets)
    .set(setClause as Partial<typeof supportTickets.$inferInsert>)
    .where(where ?? sql`true`)
    .returning({ id: supportTickets.id });

  return { matchedCount: res.length, modifiedCount: res.length };
}

/**
 * SQL equivalent of the only aggregate pipeline used by callers:
 *   [{ $group: { _id: "$status", count: { $sum: 1 } } }]
 * (app/api/platform-admin/tickets/route.ts ~:113). Returns
 * `{ _id: <status>, count: <n> }[]`.
 */
export async function aggregateSupportTickets<T = Document>(
  pipeline: Document[],
): Promise<T[]> {
  const db = getDb();
  const group = pipeline.find(
    (s) => s && typeof s === "object" && "$group" in s,
  ) as { $group?: { _id?: unknown } } | undefined;
  const groupId = group?.$group?._id;

  if (groupId === "$status") {
    const rows = await db
      .select({
        _id: supportTickets.status,
        count: sql<number>`count(*)::int`,
      })
      .from(supportTickets)
      .groupBy(supportTickets.status);
    return rows as unknown as T[];
  }

  // No other aggregate shapes are used today.
  throw new Error(
    `[pg/support-tickets] unsupported aggregate pipeline: ${JSON.stringify(
      pipeline,
    )}`,
  );
}
