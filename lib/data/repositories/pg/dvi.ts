/**
 * Postgres-backed DVI repository — the read & write surface used by
 * `lib/data/repositories/dvi.ts` when `DVI_PG_CANONICAL=1` (task #1000,
 * PACKAGE 2).
 *
 * Backs the `dvi` and `dvi_results` advisory mirror tables
 * (lib/db/schema/wave3.ts). DVI is ADVISORY-ONLY data (never a history
 * anchor) — the full legacy Mongo doc is stored verbatim in the
 * `payload` jsonb so the heterogeneous doc shape (advisor, technician,
 * categories, hunter, primaryRefs, raw, …) survives the cutover; the
 * typed columns are denormalised copies that back the indexed lookups.
 * Reads reconstruct the Mongo doc shape as `{ ...payload }` so callers
 * don't change.
 *
 * `shopId` is an INTEGER column here; the Mongo docs store shopId as
 * either a string or a number across docs. Callers normalise to
 * `Number(shopId)` before hitting PG (the Mongo side keeps the
 * string/number `$in` variant matching).
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag.
 */
import { and, desc, eq, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { dvi as dviTable, dviResults } from "@/lib/db/schema/wave3";

type AnyDoc = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function toIntOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function reconstruct(row: { payload: unknown }): AnyDoc {
  return ((row.payload as AnyDoc) ?? {}) as AnyDoc;
}

/* -------------------------------------------------------------------------- */
/* dvi (importDVI writes)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Inserts one or more `dvi` docs. Mirrors the Mongo `insertOne` /
 * `insertMany` in `importDVI`. Each doc's full shape is stored in
 * `payload`; the typed columns are denormalised copies for indexed
 * lookups.
 */
export async function insertDviDocs(docs: AnyDoc[]): Promise<void> {
  if (!docs.length) return;
  const db = getDb();
  const rows = docs.map((doc) => {
    const vehicle = (doc.vehicle as AnyDoc) ?? {};
    return {
      shopId: toIntOrNull(doc.shopId),
      roNumber: doc.roNumber != null ? String(doc.roNumber) : null,
      vin: (doc.vin as string | null) ?? (vehicle.vin as string | null) ?? null,
      sheetId: doc.sheetId != null ? String(doc.sheetId) : null,
      mileage: doc.mileage != null ? toIntOrNull(doc.mileage) : null,
      ok: typeof doc.ok === "boolean" ? doc.ok : null,
      empty: typeof doc.empty === "boolean" ? doc.empty : null,
      error: (doc.error as string | null) ?? null,
      fetchedAt: doc.fetchedAt instanceof Date ? doc.fetchedAt : null,
      notes: (doc.notes as string | null) ?? null,
      customer: (doc.customer as AnyDoc) ?? null,
      vehicle: (doc.vehicle as AnyDoc) ?? null,
      lines: (doc.lines as unknown) ?? null,
      raw: (doc.raw as unknown) ?? null,
      source: (doc.source as string | null) ?? null,
      payload: doc,
    } as typeof dviTable.$inferInsert;
  });
  await db.insert(dviTable).values(rows);
}

/* -------------------------------------------------------------------------- */
/* dvi_results (snapshot upsert + webhook cross-reference + reads)             */
/* -------------------------------------------------------------------------- */

/**
 * Upserts a `dvi_results` snapshot keyed by (shopId, roNumber). Mirrors
 * the Mongo `updateOne(..., { upsert: true })` in `upsertDviSnapshot`.
 * The full `$set` doc is merged into `payload`; `createdAt` is set only
 * on insert (Mongo `$setOnInsert`).
 */
export async function upsertDviResultSnapshot(
  shopId: number,
  roNumber: string,
  set: AnyDoc,
  setOnInsert: AnyDoc,
): Promise<void> {
  const db = getDb();
  const insertPayload = { ...setOnInsert, ...set };
  const rows = await db
    .select({ id: dviResults.id, payload: dviResults.payload })
    .from(dviResults)
    .where(
      and(
        eq(dviResults.shopId, shopId),
        eq(dviResults.roNumber, roNumber),
      ),
    )
    .limit(1);

  if (rows.length) {
    await db
      .update(dviResults)
      .set({
        vin: (set.vin as string | null) ?? null,
        payload: sql`coalesce(${dviResults.payload}, '{}'::jsonb) || ${JSON.stringify(set)}::jsonb`,
      })
      .where(eq(dviResults.id, rows[0].id));
    return;
  }

  await db.insert(dviResults).values({
    shopId,
    roNumber,
    vin: (set.vin as string | null) ?? null,
    payload: insertPayload,
  } as typeof dviResults.$inferInsert);
}

/**
 * Applies the primary-SMS cross-reference fields to the snapshot(s)
 * matching (shopId, roNumber). Mirrors the Mongo `updateOne` in
 * `webhook.ts`. Returns the matched count so the caller can preserve the
 * "snapshot may not have been written yet" warning.
 */
export async function updateDviResultCrossRef(
  shopId: number,
  roNumber: string,
  set: AnyDoc,
): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ id: dviResults.id })
    .from(dviResults)
    .where(
      and(
        eq(dviResults.shopId, shopId),
        eq(dviResults.roNumber, roNumber),
      ),
    )
    .limit(1);
  if (!rows.length) return 0;
  await db
    .update(dviResults)
    .set({
      payload: sql`coalesce(${dviResults.payload}, '{}'::jsonb) || ${JSON.stringify(set)}::jsonb`,
    })
    .where(eq(dviResults.id, rows[0].id));
  return rows.length;
}

/**
 * Finds a `dvi_results` snapshot by (shopId, roNumber). Used by the
 * cache read + extension routes.
 */
export async function findDviResultByRo(
  shopId: number,
  roNumber: string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select({ payload: dviResults.payload })
    .from(dviResults)
    .where(
      and(
        eq(dviResults.shopId, shopId),
        eq(dviResults.roNumber, roNumber),
      ),
    )
    .orderBy(desc(dviResults.receivedAt))
    .limit(1);
  return rows.length ? reconstruct(rows[0]) : null;
}

/**
 * Finds the most recent `dvi_results` snapshot matching (shopId,
 * roNumber) OR (shopId, vin), sorted newest-first. Mirrors the
 * additive Autoflow DVI lookup in ro-context.
 */
export async function findLatestDviResultByRoOrVin(
  shopId: number,
  roNumber: string,
  vin: string | null,
): Promise<AnyDoc | null> {
  const db = getDb();
  const roMatch = eq(dviResults.roNumber, roNumber);
  const match = vin
    ? or(roMatch, eq(sql`upper(${dviResults.vin})`, vin.toUpperCase()))
    : roMatch;
  const rows = await db
    .select({ payload: dviResults.payload })
    .from(dviResults)
    .where(and(eq(dviResults.shopId, shopId), match))
    .orderBy(desc(dviResults.receivedAt))
    .limit(1);
  return rows.length ? reconstruct(rows[0]) : null;
}
