// Repository for the `events` collection.
//
// task #345 (W3b): Postgres-canonical for new writes. Mongo is
// shadow-mirrored during the soak window via `WRITE_MONGO_EVENTS`
// (default ON). Reads served from PG.
//
// `events` is the firehose where AutoFlow webhook payloads (and a
// handful of UI-emitted markers like `manual_closed`) land. Callers
// here only need a small handful of access patterns: append, count,
// list-recent, find-one for debugging, and a streaming cursor for the
// AutoFlow customer backfill script.
//
// Aggregation callers (a single one in `app/api/plan-build/route.ts`)
// still talk to Mongo directly — `aggregateEvents` is preserved with
// its original Mongo semantics so no in-flight code paths regress.
// That call site moves to PG in the W3b follow-up that retires the
// Mongo `events` mirror.
import type {
  Collection,
  Document,
  Filter,
  FindCursor,
  WithId,
} from "mongodb";
import { ObjectId } from "mongodb";
import { sql as dsql, and, eq, gte, lte, type SQL } from "drizzle-orm";
// `desc` removed — order-by uses an inline `sql` template that
// supports NULLS LAST without an extra `as any` cast.
import { getDb } from "@/lib/data/db";
import { getDb as getPg } from "@/lib/db/drizzle";
import { events as pgEvents } from "@/lib/db/schema/wave3";
import {
  shadowWriteMongo,
  shouldShadowWriteMongoEvents,
} from "@/lib/db/wave3-write-mode";

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

/* -------------------------------- write --------------------------------- */

/**
 * Insert a single event row. PG-canonical with Mongo shadow.
 *
 * `createdAt` defaults to `new Date()` only if the caller hasn't
 * supplied one — webhook handlers want to record the wire-arrival
 * time precisely.
 */
export async function insertEvent(doc: EventDoc): Promise<void> {
  const createdAt = (doc.createdAt as Date | undefined) ?? new Date();
  const pg = getPg();

  // task #345 (W3b): the legacy Mongo row stored *the entire* event
  // doc — webhook callers pass top-level metadata (`token`, `raw`,
  // `objectType`, `connectionId`, `apiKey`, `operation`, …) alongside
  // a nested `payload` field. The PG row only has dedicated columns
  // for the indexable fields; everything else lands in the `payload`
  // jsonb so existing readers keep working unchanged:
  //   - `payload->>'token'` continues to find the webhook token
  //   - `payload #>> '{ticket,roNumber}'` continues to descend into
  //     the original webhook payload (its keys are spread at the top
  //     of the jsonb, *not* re-nested under another `payload` key)
  // The dedicated columns (id + indexable fields) are stripped so we
  // don't duplicate them inside the jsonb.
  const PG_COLUMN_KEYS = new Set([
    "_id",
    "provider",
    "event",
    "type",
    "shopId",
    "vehicleVin",
    "vin",
    "receivedAt",
    "createdAt",
  ]);
  const innerPayload =
    doc.payload && typeof doc.payload === "object"
      ? (doc.payload as Record<string, unknown>)
      : {};
  // Inner payload first, metadata extras layered on top — extras
  // (`token`, `raw`, `objectType`, …) take precedence on key
  // collision because they're the canonical wire-level values.
  const mergedPayload: Record<string, unknown> = { ...innerPayload };
  for (const [k, v] of Object.entries(doc)) {
    if (PG_COLUMN_KEYS.has(k) || k === "payload") continue;
    mergedPayload[k] = v;
  }

  await pg.insert(pgEvents).values({
    provider: (doc.provider as string | undefined) ?? null,
    event: (doc.event as string | undefined) ?? null,
    type: (doc.type as string | undefined) ?? null,
    shopId: doc.shopId !== undefined ? String(doc.shopId) : null,
    vehicleVin: (doc.vehicleVin as string | undefined) ?? null,
    vin: (doc.vin as string | undefined) ?? null,
    receivedAt: (doc.receivedAt as Date | undefined) ?? null,
    createdAt,
    payload: mergedPayload,
  });

  await shadowWriteMongo(shouldShadowWriteMongoEvents, "events.insert", async () => {
    const col = await collection();
    await col.insertOne({ createdAt, ...doc });
  });
}

/* --------------------------------- reads -------------------------------- */

/**
 * Build a Drizzle WHERE expression from the Mongo-flavored filter.
 *
 * Supports:
 *   - simple equality on top-level columns (`provider`, `event`, `type`,
 *     `shopId`, `vin`, `vehicleVin`)
 *   - `$gte` / `$lte` on `receivedAt` and `createdAt`
 *   - `token` filter — stored inside the JSON `payload` (no top-level
 *     column), so the predicate becomes `payload->>'token' = ?`
 *   - dotted JSON paths (e.g. `payload.ticket.roNumber`) with
 *     `$exists` / `$ne` operators, used by the debug + cron routes
 */
function buildWhere(filter: Filter<EventDoc>): SQL | undefined {
  const clauses: SQL[] = [];
  const f = filter as Record<string, unknown>;

  const eqStr = (col: typeof pgEvents.provider, v: unknown) =>
    clauses.push(eq(col, String(v)));

  if (f.provider !== undefined) eqStr(pgEvents.provider, f.provider);
  if (f.event !== undefined) eqStr(pgEvents.event, f.event);
  if (f.type !== undefined) eqStr(pgEvents.type, f.type);
  if (f.shopId !== undefined) eqStr(pgEvents.shopId, f.shopId);
  if (f.vin !== undefined) eqStr(pgEvents.vin, f.vin);
  if (f.vehicleVin !== undefined) eqStr(pgEvents.vehicleVin, f.vehicleVin);

  const addRange = (col: typeof pgEvents.receivedAt, raw: unknown) => {
    if (raw instanceof Date) {
      clauses.push(eq(col, raw));
      return;
    }
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      if (r.$gte instanceof Date) clauses.push(gte(col, r.$gte));
      if (r.$lte instanceof Date) clauses.push(lte(col, r.$lte));
    }
  };
  if (f.receivedAt !== undefined) addRange(pgEvents.receivedAt, f.receivedAt);
  if (f.createdAt !== undefined) addRange(pgEvents.createdAt, f.createdAt);

  // `token` is stored on the payload, not as a top-level column.
  if (f.token !== undefined) {
    clauses.push(dsql`${pgEvents.payload} ->> 'token' = ${String(f.token)}`);
  }

  // Dotted JSON-path filters (e.g. "payload.ticket.roNumber"). Mongo
  // supports `{$exists: true, $ne: null|""}` on these; translate to
  // PG `payload #>> ARRAY['ticket','roNumber'] IS NOT NULL` (and
  // optionally `<> ''`). Postgres's `#>>` operator requires a
  // text[] right-hand side — passing the array via the parameterized
  // template binds it as a PG text[] (no string-curly path needed).
  for (const key of Object.keys(f)) {
    if (!key.startsWith("payload.")) continue;
    const segments = key.slice("payload.".length).split(".");
    if (segments.length === 0) continue;
    const path = segments;
    const op = f[key];
    if (op && typeof op === "object") {
      const o = op as Record<string, unknown>;
      if (o.$exists === true) {
        clauses.push(dsql`${pgEvents.payload} #>> ${path}::text[] IS NOT NULL`);
      }
      if (o.$ne !== undefined) {
        const v = o.$ne;
        if (v === null) {
          clauses.push(dsql`${pgEvents.payload} #>> ${path}::text[] IS NOT NULL`);
        } else {
          clauses.push(dsql`${pgEvents.payload} #>> ${path}::text[] <> ${String(v)}`);
        }
      }
    } else if (op !== undefined) {
      clauses.push(dsql`${pgEvents.payload} #>> ${path}::text[] = ${String(op)}`);
    }
  }

  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return and(...clauses);
}

function rowToDoc(row: any): WithId<EventDoc> {
  // Synthesize a stable `_id` from the PG serial id so callers that
  // log it for diagnostics still work.
  const idStr = String(row.id).padStart(24, "0");
  const _id = ObjectId.isValid(idStr) ? new ObjectId(idStr) : new ObjectId();
  const payload = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>;
  return {
    _id,
    provider: row.provider ?? undefined,
    event: row.event ?? undefined,
    type: row.type ?? undefined,
    shopId: row.shopId ?? undefined,
    vehicleVin: row.vehicleVin ?? undefined,
    vin: row.vin ?? undefined,
    receivedAt: row.receivedAt ?? undefined,
    createdAt: row.createdAt ?? undefined,
    payload,
    ...payload,
  } as WithId<EventDoc>;
}

export async function countEvents(filter: Filter<EventDoc>): Promise<number> {
  const pg = getPg();
  const where = buildWhere(filter);
  const rows = (await pg.execute(
    where
      ? dsql`SELECT COUNT(*)::bigint AS c FROM events WHERE ${where}`
      : dsql`SELECT COUNT(*)::bigint AS c FROM events`,
  )) as unknown as Array<{ c: string | number }>;
  return Number(rows[0]?.c ?? 0);
}

export async function findOneEvent(
  filter: Filter<EventDoc>,
): Promise<WithId<EventDoc> | null> {
  const pg = getPg();
  const where = buildWhere(filter);
  const base = pg.select().from(pgEvents).$dynamic();
  const rows = where
    ? await base.where(where).limit(1)
    : await base.limit(1);
  return rows.length > 0 ? rowToDoc(rows[0]) : null;
}

/**
 * List recent events. Sort defaults to newest-first by `receivedAt`
 * because that's the field the dashboard / list views care about. The
 * `projection` argument is accepted for source compatibility but
 * ignored — PG returns the full row and rebuilds the doc shape.
 */
export async function listRecentEvents(
  filter: Filter<EventDoc>,
  options: {
    limit?: number;
    projection?: Record<string, 0 | 1>;
    sort?: Record<string, 1 | -1>;
  } = {},
): Promise<WithId<EventDoc>[]> {
  const pg = getPg();
  const where = buildWhere(filter);
  const sortField = options.sort && Object.keys(options.sort)[0] === "createdAt"
    ? pgEvents.createdAt
    : pgEvents.receivedAt;
  const base = pg.select().from(pgEvents).$dynamic();
  const filtered = where ? base.where(where) : base;
  const sorted = filtered.orderBy(dsql`${sortField} DESC NULLS LAST`);
  const rows = options.limit ? await sorted.limit(options.limit) : await sorted;
  return rows.map(rowToDoc);
}

/**
 * Stream events newest-first — used by the AutoFlow customer backfill
 * script. The caller iterates with `hasNext`/`next`. We continue to
 * back this with the Mongo cursor so the long-running backfill
 * doesn't tie up a Postgres connection for hours; the data is
 * identical during the shadow-write soak. After the soak the
 * follow-up retires this path entirely.
 */
export async function streamEvents(
  filter: Filter<EventDoc>,
  sort: Record<string, 1 | -1> = { receivedAt: -1 },
): Promise<FindCursor<WithId<EventDoc>>> {
  const col = await collection();
  return col.find(filter).sort(sort);
}

/**
 * Aggregate over the events collection — currently used by a single
 * caller in `app/api/plan-build/route.ts` for a multi-stage
 * roll-up. The aggregation pipeline is Mongo-specific so this stays
 * on the Mongo path until that caller is rewritten in the W3b
 * follow-up.
 */
export async function aggregateEvents<T = Document>(
  pipeline: Document[],
): Promise<T[]> {
  const col = await collection();
  return col.aggregate<T>(pipeline).toArray();
}
