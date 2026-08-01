/**
 * Postgres-backed AutoVitals cache repository — the read & write surface
 * used by `lib/data/repositories/autovitals-vehicles.ts`,
 * `autovitals-appointments.ts`, and `autovitals-inspections.ts` when
 * `AUTOVITALS_CACHE_PG_CANONICAL=1` (task #556).
 *
 * Backs the `autovitals_vehicles`, `autovitals_appointments`, and
 * `autovitals_inspections` mirror tables (lib/db/schema/wave3.ts). Note
 * `shop_id` is TEXT here (AutoVitals stores shopId as a string in
 * Mongo). The verbatim source document is stored in `payload` so any
 * field beyond the typed columns survives the cutover; reads return the
 * Mongo doc shape so callers don't change.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag. See
 * docs/runbooks/db-integration-cache-cutover.md.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import {
  autovitalsVehicles,
  autovitalsAppointments,
  autovitalsInspections,
} from "@/lib/db/schema/wave3";

type AnyDoc = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* vehicles                                                                    */
/* -------------------------------------------------------------------------- */

export interface PgAutoVitalsVehicleUpsertInput {
  vehicleId: number;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  mileage?: number;
  licensePlate?: string;
  color?: string;
  customerId?: number;
  customerName?: string;
  [k: string]: unknown;
}

export async function upsertAutoVitalsVehicle(
  vehicle: PgAutoVitalsVehicleUpsertInput,
  shopId: string,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const set: AnyDoc = {
    vin: vehicle.vin ?? null,
    year: vehicle.year ?? null,
    make: vehicle.make ?? null,
    model: vehicle.model ?? null,
    mileage: vehicle.mileage ?? null,
    licensePlate: vehicle.licensePlate ?? null,
    color: vehicle.color ?? null,
    customerId: vehicle.customerId ?? null,
    customerName: vehicle.customerName ?? null,
    payload: { ...vehicle, shopId },
    updatedAt: now,
  };
  await db
    .insert(autovitalsVehicles)
    .values({
      shopId,
      vehicleId: vehicle.vehicleId,
      ...set,
      createdAt: now,
    } as typeof autovitalsVehicles.$inferInsert)
    .onConflictDoUpdate({
      target: [autovitalsVehicles.shopId, autovitalsVehicles.vehicleId],
      set: set as Partial<typeof autovitalsVehicles.$inferInsert>,
    });
}

function reconstructVehicle(row: typeof autovitalsVehicles.$inferSelect): AnyDoc {
  const payload = (row.payload as AnyDoc) ?? {};
  return {
    ...payload,
    vehicleId: row.vehicleId,
    shopId: row.shopId,
    vin: row.vin ?? undefined,
    year: row.year ?? undefined,
    make: row.make ?? undefined,
    model: row.model ?? undefined,
    mileage: row.mileage ?? undefined,
    licensePlate: row.licensePlate ?? undefined,
    color: row.color ?? undefined,
    customerId: row.customerId ?? undefined,
    customerName: row.customerName ?? undefined,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

export async function findAutoVitalsVehicleByVin(
  vin: string,
  shopId: string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(autovitalsVehicles)
    .where(
      and(
        eq(autovitalsVehicles.shopId, shopId),
        eq(autovitalsVehicles.vin, vin),
      ),
    )
    .limit(1);
  return rows.length ? reconstructVehicle(rows[0]) : null;
}

export async function findAutoVitalsVehicleByVinCaseInsensitive(
  vinUpper: string,
  shopId: string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(autovitalsVehicles)
    .where(
      and(
        eq(autovitalsVehicles.shopId, shopId),
        sql`upper(${autovitalsVehicles.vin}) = ${vinUpper.toUpperCase()}`,
      ),
    )
    .limit(1);
  return rows.length ? reconstructVehicle(rows[0]) : null;
}

/* -------------------------------------------------------------------------- */
/* appointments                                                                */
/* -------------------------------------------------------------------------- */

export interface PgAutoVitalsAppointmentUpsertInput {
  appointmentId: number;
  vehicleId?: number;
  vin?: string;
  customerId?: number;
  customerName?: string;
  customerPhone?: string;
  status?: string;
  promisedTime?: string;
  serviceAdvisorId?: number;
  technicianId?: number;
  concern?: string;
  mileageIn?: number;
  [k: string]: unknown;
}

export async function upsertAutoVitalsAppointment(
  appointment: PgAutoVitalsAppointmentUpsertInput,
  shopId: string,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const set: AnyDoc = {
    vehicleId: appointment.vehicleId ?? null,
    vin: appointment.vin ?? null,
    customerId: appointment.customerId ?? null,
    customerName: appointment.customerName ?? null,
    customerPhone: appointment.customerPhone ?? null,
    status: appointment.status ?? null,
    promisedTime: appointment.promisedTime ?? null,
    serviceAdvisorId: appointment.serviceAdvisorId ?? null,
    technicianId: appointment.technicianId ?? null,
    concern: appointment.concern ?? null,
    mileageIn: appointment.mileageIn ?? null,
    payload: { ...appointment, shopId },
    updatedAt: now,
  };
  await db
    .insert(autovitalsAppointments)
    .values({
      shopId,
      appointmentId: appointment.appointmentId,
      ...set,
      createdAt: now,
    } as typeof autovitalsAppointments.$inferInsert)
    .onConflictDoUpdate({
      target: [
        autovitalsAppointments.shopId,
        autovitalsAppointments.appointmentId,
      ],
      set: set as Partial<typeof autovitalsAppointments.$inferInsert>,
    });
}

function reconstructAppointment(
  row: typeof autovitalsAppointments.$inferSelect,
): AnyDoc {
  const payload = (row.payload as AnyDoc) ?? {};
  return {
    ...payload,
    appointmentId: row.appointmentId,
    shopId: row.shopId,
    vehicleId: row.vehicleId ?? undefined,
    vin: row.vin ?? undefined,
    customerId: row.customerId ?? undefined,
    customerName: row.customerName ?? undefined,
    customerPhone: row.customerPhone ?? undefined,
    status: row.status ?? undefined,
    promisedTime: row.promisedTime ?? undefined,
    serviceAdvisorId: row.serviceAdvisorId ?? undefined,
    technicianId: row.technicianId ?? undefined,
    concern: row.concern ?? undefined,
    mileageIn: row.mileageIn ?? undefined,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

export async function findLatestAppointmentForVehicle(
  shopId: string,
  vehicleId: number,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(autovitalsAppointments)
    .where(
      and(
        eq(autovitalsAppointments.shopId, shopId),
        eq(autovitalsAppointments.vehicleId, vehicleId),
      ),
    )
    .orderBy(desc(autovitalsAppointments.updatedAt))
    .limit(1);
  return rows.length ? reconstructAppointment(rows[0]) : null;
}

export async function countAutoVitalsAppointments(
  shopId: string,
): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(autovitalsAppointments)
    .where(eq(autovitalsAppointments.shopId, shopId));
  return rows[0]?.count ?? 0;
}

export async function deleteAutoVitalsAppointmentsForShop(
  shopId: number,
): Promise<number> {
  const db = getDb();
  // shop_id is TEXT; the cache writes the string spelling, so match both
  // the string and numeric renderings to mirror the Mongo `$or`.
  const result = await db
    .delete(autovitalsAppointments)
    .where(
      sql`${autovitalsAppointments.shopId} in (${String(shopId)}, ${String(Number(shopId))})`,
    )
    .returning({ shopId: autovitalsAppointments.shopId });
  return result.length;
}

/* -------------------------------------------------------------------------- */
/* inspections                                                                 */
/* -------------------------------------------------------------------------- */

export interface PgAutoVitalsInspectionUpsertInput {
  appointmentId: number;
  inspectionResultId?: number;
  completedAt?: string;
  technicianId?: number;
  technicianName?: string;
  items?: unknown[];
  [k: string]: unknown;
}

export async function upsertAutoVitalsInspection(
  inspection: PgAutoVitalsInspectionUpsertInput,
  shopId: string,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const set: AnyDoc = {
    inspectionResultId: inspection.inspectionResultId ?? null,
    completedAt: inspection.completedAt ?? null,
    technicianId: inspection.technicianId ?? null,
    technicianName: inspection.technicianName ?? null,
    items: (inspection.items ?? null) as unknown,
    payload: { ...inspection, shopId },
    updatedAt: now,
  };
  await db
    .insert(autovitalsInspections)
    .values({
      shopId,
      appointmentId: inspection.appointmentId,
      ...set,
      createdAt: now,
    } as typeof autovitalsInspections.$inferInsert)
    .onConflictDoUpdate({
      target: [
        autovitalsInspections.shopId,
        autovitalsInspections.appointmentId,
      ],
      set: set as Partial<typeof autovitalsInspections.$inferInsert>,
    });
}

function reconstructInspection(
  row: typeof autovitalsInspections.$inferSelect,
): AnyDoc {
  const payload = (row.payload as AnyDoc) ?? {};
  return {
    ...payload,
    appointmentId: row.appointmentId,
    shopId: row.shopId,
    inspectionResultId: row.inspectionResultId ?? undefined,
    completedAt: row.completedAt ?? undefined,
    technicianId: row.technicianId ?? undefined,
    technicianName: row.technicianName ?? undefined,
    items: row.items ?? undefined,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

export async function findAutoVitalsInspection(
  appointmentId: number,
  shopId: string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(autovitalsInspections)
    .where(
      and(
        eq(autovitalsInspections.shopId, shopId),
        eq(autovitalsInspections.appointmentId, appointmentId),
      ),
    )
    .limit(1);
  return rows.length ? reconstructInspection(rows[0]) : null;
}

export async function findLatestInspectionForAppointment(
  shopId: string,
  appointmentId: number,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(autovitalsInspections)
    .where(
      and(
        eq(autovitalsInspections.shopId, shopId),
        eq(autovitalsInspections.appointmentId, appointmentId),
      ),
    )
    .orderBy(desc(autovitalsInspections.updatedAt))
    .limit(1);
  return rows.length ? reconstructInspection(rows[0]) : null;
}

export async function countAutoVitalsInspections(
  shopId: string,
): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(autovitalsInspections)
    .where(eq(autovitalsInspections.shopId, shopId));
  return rows[0]?.count ?? 0;
}

/**
 * Raw insert of a browser-extension DVI capture. These docs have no
 * AutoVitals `appointmentId`, so we synthesize a unique negative key
 * (the table PK is `(shopId, appointmentId)`) and stash the verbatim
 * doc in `payload`. Returns the synthetic appointmentId as the id.
 */
export async function insertAutoVitalsInspectionDoc(
  doc: AnyDoc,
): Promise<unknown> {
  const db = getDb();
  const now = new Date();
  const shopId = String(doc.shopId ?? "");
  const syntheticId = -now.getTime();
  await db.insert(autovitalsInspections).values({
    shopId,
    appointmentId: syntheticId,
    completedAt:
      typeof doc.inspectionDate === "string"
        ? (doc.inspectionDate as string)
        : null,
    payload: doc,
    updatedAt: now,
    createdAt: now,
  } as typeof autovitalsInspections.$inferInsert);
  return syntheticId;
}
