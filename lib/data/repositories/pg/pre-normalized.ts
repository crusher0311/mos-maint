/**
 * Postgres-backed pre-normalized identity store repository — the read &
 * write surface used by `lib/data/repositories/vehicles.ts` and
 * `lib/data/repositories/customers.ts` when their domain is PG-canonical
 * (task #1000, flag `LEGACY_VEHICLES_PG_CANONICAL=1`).
 *
 * Backs the `pre_normalized_vehicles`, `pre_normalized_customers` and
 * `pre_normalized_manual_vehicles` mirror tables (lib/db/schema/wave3.ts).
 * The full Mongo snapshot is stored verbatim in the `payload` jsonb so the
 * legacy doc shape survives the cutover; the typed columns are
 * denormalised copies that back the indexed lookups. Reads reconstruct
 * the Mongo doc shape from `payload` (merged with the typed columns) so
 * callers don't change.
 *
 * CRITICAL shopId quirk (mirrors the Mongo semantics):
 *   Mongo `vehicles` docs stored `shopId` inconsistently — missing, a
 *   string, or a number across docs. Reads are shop-scoped with `$in`
 *   variants. In PG we normalise `shop_id` to text (integer column cast
 *   to text for `vehicles`/`manual_vehicles`; the `customers` column is
 *   already text) and scope reads with
 *   `shop_id::text = ANY(variants) OR shop_id IS NULL`, matching the
 *   current `{ shopId: { $in: [String, Number] } }` behaviour plus the
 *   docs that never carried a shopId.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repos next to the call
 * sites — this file has no knowledge of the kill-switch flag.
 */
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import {
  preNormalizedVehicles,
  preNormalizedCustomers,
  preNormalizedManualVehicles,
} from "@/lib/db/schema/wave3";

type AnyDoc = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function asInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length ? s : null;
}

/** String + Number variants of a shopId, matching Mongo `$in` scoping. */
function shopVariants(shopId: string | number): string[] {
  const set = new Set<string>();
  set.add(String(shopId));
  const n = Number(shopId);
  if (Number.isFinite(n)) set.add(String(n));
  return [...set];
}

/* -------------------------------------------------------------------------- */
/* vehicles                                                                    */
/* -------------------------------------------------------------------------- */

function reconstructVehicle(row: {
  shopId: number | null;
  vin: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  lastMileage: number | null;
  declined: unknown;
  components: unknown;
  payload: unknown;
}): AnyDoc {
  const payload = (row.payload as AnyDoc) ?? {};
  const doc: AnyDoc = { ...payload };
  // Typed columns win over stale payload copies where set.
  if (row.shopId != null) doc.shopId = row.shopId;
  if (row.vin != null) doc.vin = row.vin;
  if (row.year != null) doc.year = row.year;
  if (row.make != null) doc.make = row.make;
  if (row.model != null) doc.model = row.model;
  if (row.trim != null) doc.trim = row.trim;
  if (row.lastMileage != null) doc.lastMileage = row.lastMileage;
  if (row.declined != null) doc.declined = row.declined;
  if (row.components != null) doc.components = row.components;
  return doc;
}

/**
 * Shop-scoped vehicle lookup by VIN. `shopId` optional: when omitted the
 * lookup is VIN-only (mirrors `findOne({ vin })` call sites). When present
 * it is matched against the string/number variants OR a missing shop_id,
 * mirroring the Mongo `{ shopId: { $in: [...] } }` semantics on docs that
 * historically stored shopId inconsistently.
 */
export async function findVehicleByVin(
  vin: string,
  shopId?: string | number,
): Promise<AnyDoc | null> {
  const db = getDb();
  const conds = [eq(preNormalizedVehicles.vin, vin)];
  if (shopId !== undefined) {
    const variants = shopVariants(shopId);
    const scoped = or(
      sql`${preNormalizedVehicles.shopId}::text = ANY(${variants})`,
      isNull(preNormalizedVehicles.shopId),
    );
    if (scoped) conds.push(scoped);
  }
  const rows = await db
    .select()
    .from(preNormalizedVehicles)
    .where(and(...conds))
    .orderBy(desc(preNormalizedVehicles.updatedAt))
    .limit(1);
  return rows.length ? reconstructVehicle(rows[0]) : null;
}

export interface PgVehicleUpsertFields {
  shopId?: number | string | null;
  vin?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  lastMileage?: number | null;
  declined?: unknown;
  components?: unknown;
  [k: string]: unknown;
}

function vehicleColumns(set: PgVehicleUpsertFields): AnyDoc {
  const row: AnyDoc = {};
  if (set.shopId !== undefined) row.shopId = asInt(set.shopId);
  if (set.vin !== undefined) row.vin = asStr(set.vin);
  if (set.year !== undefined) row.year = asInt(set.year);
  if (set.make !== undefined) row.make = asStr(set.make);
  if (set.model !== undefined) row.model = asStr(set.model);
  if (set.trim !== undefined) row.trim = asStr(set.trim);
  if (set.lastMileage !== undefined) row.lastMileage = asInt(set.lastMileage);
  if (set.declined !== undefined) row.declined = set.declined ?? null;
  if (set.components !== undefined) row.components = set.components ?? null;
  return row;
}

/**
 * Upsert a vehicle snapshot keyed on (shop_id, vin). The full merged doc
 * is stored in `payload`; typed columns mirror the indexed fields.
 */
export async function upsertVehicleSnapshot(
  shopId: number | string | null,
  vin: string,
  fullDoc: AnyDoc,
): Promise<void> {
  const db = getDb();
  const cols = vehicleColumns({ ...(fullDoc as PgVehicleUpsertFields), shopId, vin });
  const shopInt = asInt(shopId);
  const variants = shopInt != null ? [String(shopInt)] : [];

  const where =
    shopInt != null
      ? and(
          eq(preNormalizedVehicles.vin, vin),
          sql`${preNormalizedVehicles.shopId}::text = ANY(${variants})`,
        )
      : and(eq(preNormalizedVehicles.vin, vin), isNull(preNormalizedVehicles.shopId));

  const existing = await db
    .select({ id: preNormalizedVehicles.id, payload: preNormalizedVehicles.payload })
    .from(preNormalizedVehicles)
    .where(where)
    .limit(1);

  if (existing.length) {
    const merged = { ...((existing[0].payload as AnyDoc) ?? {}), ...fullDoc };
    await db
      .update(preNormalizedVehicles)
      .set({
        ...cols,
        payload: merged,
        updatedAt: new Date(),
      } as Partial<typeof preNormalizedVehicles.$inferInsert>)
      .where(eq(preNormalizedVehicles.id, existing[0].id));
  } else {
    await db.insert(preNormalizedVehicles).values({
      ...cols,
      payload: fullDoc,
    } as typeof preNormalizedVehicles.$inferInsert);
  }
}

/* -------------------------------------------------------------------------- */
/* customers                                                                   */
/* -------------------------------------------------------------------------- */

function reconstructCustomer(row: {
  shopId: string | null;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  externalId: string | null;
  status: string | null;
  provider: string | null;
  lastVin: string | null;
  lastRo: string | null;
  lastMileage: number | null;
  payload: unknown;
}): AnyDoc {
  const payload = (row.payload as AnyDoc) ?? {};
  const doc: AnyDoc = { ...payload };
  if (row.shopId != null) doc.shopId = row.shopId;
  if (row.name != null) doc.name = row.name;
  if (row.firstName != null) doc.firstName = row.firstName;
  if (row.lastName != null) doc.lastName = row.lastName;
  if (row.email != null) doc.email = row.email;
  if (row.phone != null) doc.phone = row.phone;
  if (row.externalId != null) doc.externalId = row.externalId;
  if (row.status != null) doc.status = row.status;
  if (row.provider != null) doc.provider = row.provider;
  if (row.lastVin != null) doc.lastVin = row.lastVin;
  if (row.lastRo != null) doc.lastRo = row.lastRo;
  if (row.lastMileage != null) doc.lastMileage = row.lastMileage;
  return doc;
}

export interface PgCustomerUpsertFields {
  shopId?: number | string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
  status?: string | null;
  provider?: string | null;
  lastVin?: string | null;
  lastRo?: string | null;
  lastMileage?: number | null;
  [k: string]: unknown;
}

function customerColumns(set: PgCustomerUpsertFields): AnyDoc {
  const row: AnyDoc = {};
  if (set.shopId !== undefined) row.shopId = set.shopId != null ? String(set.shopId) : null;
  if (set.name !== undefined) row.name = asStr(set.name);
  if (set.firstName !== undefined) row.firstName = asStr(set.firstName);
  if (set.lastName !== undefined) row.lastName = asStr(set.lastName);
  if (set.email !== undefined) row.email = asStr(set.email);
  if (set.phone !== undefined) row.phone = asStr(set.phone);
  if (set.externalId !== undefined) row.externalId = asStr(set.externalId);
  if (set.status !== undefined) row.status = asStr(set.status);
  if (set.provider !== undefined) row.provider = asStr(set.provider);
  if (set.lastVin !== undefined) row.lastVin = asStr(set.lastVin);
  if (set.lastRo !== undefined) row.lastRo = asStr(set.lastRo);
  if (set.lastMileage !== undefined) row.lastMileage = asInt(set.lastMileage);
  return row;
}

/**
 * Upsert a customer identified by a selector object (mirrors the Mongo
 * `updateOne(selector, ..., { upsert: true })` call in
 * lib/upsert-customer.ts and lib/models/customers.ts). Only shopId +
 * externalId/email/phone/name/vin selectors are supported — those are the
 * shapes the gated callers use. The full merged doc is stored in
 * `payload`; typed columns mirror the indexed fields.
 */
export async function upsertCustomerBySelector(
  selector: AnyDoc,
  fullDoc: AnyDoc,
): Promise<void> {
  const db = getDb();
  const conds = buildCustomerSelector(selector);
  const cols = customerColumns(fullDoc as PgCustomerUpsertFields);

  const existing = await db
    .select({ id: preNormalizedCustomers.id, payload: preNormalizedCustomers.payload })
    .from(preNormalizedCustomers)
    .where(and(...conds))
    .limit(1);

  if (existing.length) {
    const merged = { ...((existing[0].payload as AnyDoc) ?? {}), ...fullDoc };
    await db
      .update(preNormalizedCustomers)
      .set({
        ...cols,
        payload: merged,
        updatedAt: new Date(),
      } as Partial<typeof preNormalizedCustomers.$inferInsert>)
      .where(eq(preNormalizedCustomers.id, existing[0].id));
  } else {
    await db.insert(preNormalizedCustomers).values({
      ...cols,
      payload: fullDoc,
    } as typeof preNormalizedCustomers.$inferInsert);
  }
}

/**
 * Insert a brand-new customer row unconditionally (mirrors the Mongo
 * `insertOne` used for no-identity webhook payloads and manual creates —
 * each call MUST produce a distinct row; never selector-matched).
 * Returns the new PG row id as a string handle.
 */
export async function insertCustomer(fullDoc: AnyDoc): Promise<string> {
  const db = getDb();
  const cols = customerColumns(fullDoc as PgCustomerUpsertFields);
  const rows = await db
    .insert(preNormalizedCustomers)
    .values({
      ...cols,
      payload: fullDoc,
    } as typeof preNormalizedCustomers.$inferInsert)
    .returning({ id: preNormalizedCustomers.id });
  return String(rows[0].id);
}

/**
 * Find a single customer row by a Mongo-shaped selector. Returns the raw
 * row (id + payload + typed columns) so callers can merge into a follow-up
 * upsert. Returns null when no row matches.
 */
export async function findCustomerBySelector(
  selector: AnyDoc,
): Promise<(AnyDoc & { id: number; payload: unknown }) | null> {
  const db = getDb();
  const conds = buildCustomerSelector(selector);
  if (!conds.length) return null;
  const rows = await db
    .select()
    .from(preNormalizedCustomers)
    .where(and(...conds))
    .orderBy(desc(preNormalizedCustomers.updatedAt))
    .limit(1);
  if (!rows.length) return null;
  const row = rows[0];
  return { ...reconstructCustomer(row), id: row.id, payload: row.payload };
}

/**
 * Update a customer by its PG row id, merging `fields` into the payload and
 * typed columns.
 */
export async function updateCustomerById(
  id: string,
  fields: PgCustomerUpsertFields,
): Promise<void> {
  const db = getDb();
  const numId = Number(id);
  if (!Number.isFinite(numId)) return;
  const cols = customerColumns(fields);
  const existing = await db
    .select({ id: preNormalizedCustomers.id, payload: preNormalizedCustomers.payload })
    .from(preNormalizedCustomers)
    .where(eq(preNormalizedCustomers.id, numId))
    .limit(1);
  if (!existing.length) return;
  const merged = { ...((existing[0].payload as AnyDoc) ?? {}), ...fields };
  await db
    .update(preNormalizedCustomers)
    .set({
      ...cols,
      payload: merged,
      updatedAt: new Date(),
    } as Partial<typeof preNormalizedCustomers.$inferInsert>)
    .where(eq(preNormalizedCustomers.id, numId));
}

/**
 * Translate a Mongo-shaped customer selector into PG conditions. Supports
 * shopId (string/number scoped), externalId, email, phone, name and the
 * nested `vehicle.vin` / `lastVin` selectors the gated callers use.
 */
function buildCustomerSelector(selector: AnyDoc): ReturnType<typeof eq>[] {
  const conds: ReturnType<typeof eq>[] = [];
  if (selector.shopId !== undefined && selector.shopId !== null) {
    const variants = shopVariants(selector.shopId as string | number);
    const scoped = sql`${preNormalizedCustomers.shopId} = ANY(${variants})`;
    conds.push(scoped as unknown as ReturnType<typeof eq>);
  }
  if (typeof selector.externalId === "string") {
    conds.push(eq(preNormalizedCustomers.externalId, selector.externalId));
  }
  if (typeof selector.email === "string") {
    conds.push(eq(preNormalizedCustomers.email, selector.email));
  }
  if (typeof selector.phone === "string") {
    conds.push(eq(preNormalizedCustomers.phone, selector.phone));
  }
  if (typeof selector.name === "string") {
    conds.push(eq(preNormalizedCustomers.name, selector.name));
  }
  // vehicle.vin / lastVin selectors resolve against the denormalised
  // last_vin column (the payload keeps the nested `vehicle.vin`).
  const vin =
    (selector["vehicle.vin"] as string | undefined) ??
    (selector.lastVin as string | undefined);
  if (typeof vin === "string") {
    conds.push(eq(preNormalizedCustomers.lastVin, vin));
  }
  return conds;
}

/**
 * Dashboard "open customers" read. Mirrors the Mongo query:
 *   shopId in [String, Number] AND status NOT IN closedSet
 *   AND vehicle.vin present (non-empty), sorted by updatedAt desc, limit N.
 * Returns reconstructed docs (payload merged with typed columns) so the
 * caller's projection expectations (name/status/lastTicketId/updatedAt/
 * nested `vehicle`) are satisfied from the stored payload.
 */
export async function findOpenCustomersForDashboard(
  shopId: number | string,
  closedSet: readonly string[],
  limit: number,
): Promise<AnyDoc[]> {
  const db = getDb();
  const variants = shopVariants(shopId);
  const rows = await db
    .select()
    .from(preNormalizedCustomers)
    .where(
      and(
        sql`${preNormalizedCustomers.shopId} = ANY(${variants})`,
        sql`COALESCE(${preNormalizedCustomers.payload} ->> 'status', '') <> ALL(${[
          ...closedSet,
        ]})`,
        sql`COALESCE(${preNormalizedCustomers.payload} #>> '{vehicle,vin}', '') <> ''`,
      ),
    )
    .orderBy(desc(preNormalizedCustomers.updatedAt))
    .limit(limit);
  return rows.map(reconstructCustomer);
}

/* -------------------------------------------------------------------------- */
/* manual_vehicles                                                             */
/* -------------------------------------------------------------------------- */

function reconstructManualVehicle(row: {
  shopId: number | null;
  vin: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  enteredBy: string | null;
  payload: unknown;
}): AnyDoc {
  const payload = (row.payload as AnyDoc) ?? {};
  const doc: AnyDoc = { ...payload };
  if (row.shopId != null) doc.shopId = row.shopId;
  if (row.vin != null) doc.vin = row.vin;
  if (row.year != null) doc.vehicleYear = row.year;
  if (row.make != null) doc.vehicleMake = row.make;
  if (row.model != null) doc.vehicleModel = row.model;
  if (row.enteredBy != null) doc.createdBy = row.enteredBy;
  return doc;
}

function manualVehicleColumns(doc: AnyDoc): AnyDoc {
  return {
    shopId: asInt(doc.shopId),
    vin: asStr(doc.vin),
    year: asInt(doc.vehicleYear ?? doc.year),
    make: asStr(doc.vehicleMake ?? doc.make),
    model: asStr(doc.vehicleModel ?? doc.model),
    enteredBy: asStr(doc.createdBy ?? doc.enteredBy),
  };
}

/**
 * Find an active (non-archived) manual vehicle for a shop + VIN. Mirrors
 * `findOne({ shopId, vin, archived: { $ne: true } })`.
 */
export async function findActiveManualVehicle(
  shopId: number,
  vin: string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(preNormalizedManualVehicles)
    .where(
      and(
        eq(preNormalizedManualVehicles.shopId, shopId),
        eq(preNormalizedManualVehicles.vin, vin),
        sql`COALESCE((${preNormalizedManualVehicles.payload} ->> 'archived')::boolean, false) = false`,
      ),
    )
    .orderBy(desc(preNormalizedManualVehicles.createdAt))
    .limit(1);
  return rows.length ? reconstructManualVehicle(rows[0]) : null;
}

/**
 * Insert or update a manual vehicle keyed on (shop_id, vin). The full doc
 * (including `archived`, `customerName`, `roNumber`, `mileage`, …) lives in
 * `payload`; typed columns mirror the indexed fields.
 */
export async function upsertManualVehicle(
  shopId: number,
  vin: string,
  fullDoc: AnyDoc,
): Promise<void> {
  const db = getDb();
  const cols = manualVehicleColumns({ ...fullDoc, shopId, vin });

  const existing = await db
    .select({ id: preNormalizedManualVehicles.id, payload: preNormalizedManualVehicles.payload })
    .from(preNormalizedManualVehicles)
    .where(
      and(
        eq(preNormalizedManualVehicles.shopId, shopId),
        eq(preNormalizedManualVehicles.vin, vin),
      ),
    )
    .limit(1);

  if (existing.length) {
    const merged = { ...((existing[0].payload as AnyDoc) ?? {}), ...fullDoc };
    await db
      .update(preNormalizedManualVehicles)
      .set({
        ...cols,
        payload: merged,
      } as Partial<typeof preNormalizedManualVehicles.$inferInsert>)
      .where(eq(preNormalizedManualVehicles.id, existing[0].id));
  } else {
    await db.insert(preNormalizedManualVehicles).values({
      ...cols,
      payload: fullDoc,
    } as typeof preNormalizedManualVehicles.$inferInsert);
  }
}

/**
 * Archive a manual vehicle for a shop + VIN (soft delete). Mirrors
 * `updateOne({ shopId, vin }, { $set: { archived: true, updatedAt } })`.
 */
export async function archiveManualVehicle(
  shopId: number,
  vin: string,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .update(preNormalizedManualVehicles)
    .set({
      payload: sql`COALESCE(${preNormalizedManualVehicles.payload}, '{}'::jsonb) || ${JSON.stringify(
        { archived: true, updatedAt: now },
      )}::jsonb`,
    } as Partial<typeof preNormalizedManualVehicles.$inferInsert>)
    .where(
      and(
        eq(preNormalizedManualVehicles.shopId, shopId),
        eq(preNormalizedManualVehicles.vin, vin),
      ),
    );
}
