/**
 * Postgres-backed AutoFlow cache repository — the read & write surface
 * used by `lib/data/repositories/autoflow-cache.ts` when
 * `AUTOFLOW_CACHE_PG_CANONICAL=1` (task #556).
 *
 * Backs the `autoflow_dvi_items`, `autoflow_events`, and `af_open`
 * mirror tables (lib/db/schema/wave3.ts). The append-only DVI-item and
 * event collections have no natural key, so the schema carries a
 * `serial id` plus indexed lookup columns (`shop_id`, `vin`,
 * `received_at`) alongside the verbatim source document in `payload`.
 * Reads return the Mongo doc shape (the stored payload merged with the
 * typed columns) so callers don't change.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag. See
 * docs/runbooks/db-integration-cache-cutover.md.
 */
import { and, desc, eq, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import {
  autoflowDviItems,
  autoflowEvents,
  afOpen,
} from "@/lib/db/schema/wave3";

type AnyDoc = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* dvi_items                                                                   */
/* -------------------------------------------------------------------------- */

export interface PgAutoflowDviItemInsertInput {
  shopId: number;
  dviId?: string | null;
  itemId?: string | null;
  vin?: string | null;
  label?: string | null;
  severity?: string | null;
  note?: string | null;
  [k: string]: unknown;
}

export async function insertDviItems(
  items: PgAutoflowDviItemInsertInput[],
): Promise<void> {
  if (!items.length) return;
  const db = getDb();
  const now = new Date();
  const rows = items.map(
    (item) =>
      ({
        shopId: item.shopId,
        dviId: item.dviId ?? null,
        itemId: item.itemId ?? null,
        vin: item.vin ?? null,
        label: item.label ?? null,
        severity: item.severity ?? null,
        note: item.note ?? null,
        payload: item,
        receivedAt: now,
      }) as typeof autoflowDviItems.$inferInsert,
  );
  await db.insert(autoflowDviItems).values(rows);
}

function reconstructDviItem(
  row: typeof autoflowDviItems.$inferSelect,
): AnyDoc {
  const payload = (row.payload as AnyDoc) ?? {};
  return {
    ...payload,
    shopId: row.shopId,
    dviId: row.dviId ?? undefined,
    itemId: row.itemId ?? undefined,
    vin: row.vin ?? undefined,
    label: row.label ?? undefined,
    severity: row.severity ?? undefined,
    note: row.note ?? undefined,
  };
}

/**
 * Mirrors the Mongo `autoflow_dvi_items.find({ vin }).limit(500)` read
 * in `lib/evidence.ts` — filter by `vin` only, return Mongo-shaped docs
 * with `_id` omitted (the verbatim payload never carried `_id`).
 */
export async function findDviItemsByVin(vin: string): Promise<AnyDoc[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(autoflowDviItems)
    .where(eq(autoflowDviItems.vin, vin))
    .limit(500);
  return rows.map(reconstructDviItem);
}

/* -------------------------------------------------------------------------- */
/* events                                                                      */
/* -------------------------------------------------------------------------- */

export interface PgAutoflowEventInsertInput {
  shopId?: number | null;
  eventType?: string | null;
  vin?: string | null;
  [k: string]: unknown;
}

export async function insertEvent(
  event: PgAutoflowEventInsertInput,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db.insert(autoflowEvents).values({
    shopId: event.shopId ?? null,
    eventType: event.eventType ?? null,
    vin: event.vin ?? null,
    payload: event,
    receivedAt: now,
  } as typeof autoflowEvents.$inferInsert);
}

function reconstructEvent(row: typeof autoflowEvents.$inferSelect): AnyDoc {
  const payload = (row.payload as AnyDoc) ?? {};
  return {
    ...payload,
    shopId: row.shopId ?? undefined,
    eventType: row.eventType ?? undefined,
    vin: row.vin ?? undefined,
  };
}

/**
 * Mirrors the Mongo `autoflow_events.findOne` read in
 * app/dashboard/vehicles/[vin]/plan/page.tsx:
 *
 *   { shopId, $or: [ { vehicleVin: /^vin$/i }, { vin: /^vin$/i },
 *                    { "payload.vehicle.vin": /^vin$/i } ] }
 *   sort: { createdAt: -1 }
 *
 * The VIN can live in one of three places in the source doc, all of
 * which are preserved verbatim in the `payload` jsonb. We match the
 * indexed `vin` column (populated from the source doc on write) plus a
 * case-insensitive JSONB match on the two nested locations so the
 * lookup mirrors Mongo exactly. `createdAt` lives inside the payload
 * (Mongo webhook doc field); we order by that, falling back to the
 * `received_at` column.
 */
export async function findLatestEventByVin(
  shopId: number,
  vin: string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const vinUpper = vin.toUpperCase();
  const rows = await db
    .select()
    .from(autoflowEvents)
    .where(
      and(
        eq(autoflowEvents.shopId, shopId),
        or(
          sql`upper(${autoflowEvents.vin}) = ${vinUpper}`,
          sql`upper(${autoflowEvents.payload}->>'vehicleVin') = ${vinUpper}`,
          sql`upper(${autoflowEvents.payload}->>'vin') = ${vinUpper}`,
          sql`upper(${autoflowEvents.payload}#>>'{payload,vehicle,vin}') = ${vinUpper}`,
        ),
      ),
    )
    .orderBy(
      desc(sql`coalesce((${autoflowEvents.payload}->>'createdAt'), '')`),
      desc(autoflowEvents.receivedAt),
    )
    .limit(1);
  return rows.length ? reconstructEvent(rows[0]) : null;
}

/* -------------------------------------------------------------------------- */
/* af_open                                                                     */
/* -------------------------------------------------------------------------- */

export interface PgAfOpenUpsertInput {
  shopId: number;
  roNumber: string;
  payload: unknown;
}

export async function upsertAfOpen(
  input: PgAfOpenUpsertInput,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(afOpen)
    .values({
      shopId: input.shopId,
      roNumber: input.roNumber,
      payload: input.payload,
      updatedAt: now,
    } as typeof afOpen.$inferInsert)
    .onConflictDoUpdate({
      target: [afOpen.shopId, afOpen.roNumber],
      set: {
        payload: input.payload,
        updatedAt: now,
      } as Partial<typeof afOpen.$inferInsert>,
    });
}

export async function findAfOpen(
  shopId: number,
  roNumber: string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(afOpen)
    .where(and(eq(afOpen.shopId, shopId), eq(afOpen.roNumber, roNumber)))
    .limit(1);
  if (!rows.length) return null;
  const row = rows[0];
  const payload = (row.payload as AnyDoc) ?? {};
  return {
    ...payload,
    shopId: row.shopId,
    roNumber: row.roNumber,
    updatedAt: row.updatedAt,
  };
}
