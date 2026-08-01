// Repository for the `autovitals_appointments` collection.
//
// Caches AutoVitals appointments keyed by (appointmentId, shopId).
// `shopId` is stored as a string.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isAutovitalsCachePgCanonical,
  shouldShadowWriteMongoAutovitalsCache,
  shadowWriteMongoIntegrationCache,
} from "@/lib/db/integration-cache-write-mode";
import * as pg from "./pg/autovitals-cache";

const COLLECTION = "autovitals_appointments";

export interface AutoVitalsAppointmentCacheDoc extends Document {
  appointmentId: number;
  shopId: string;
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
  updatedAt?: Date;
  createdAt?: Date;
}

async function collection(): Promise<Collection<AutoVitalsAppointmentCacheDoc>> {
  const db = await getDb();
  return db.collection<AutoVitalsAppointmentCacheDoc>(COLLECTION);
}

export interface AutoVitalsAppointmentUpsertInput {
  appointmentId: number;
  vehicleId?: number;
  vin?: string;
  customerId?: number;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  status?: string;
  promisedTime?: string;
  dropOffTime?: string;
  serviceAdvisorId?: number;
  serviceAdvisorName?: string;
  technicianId?: number;
  technicianName?: string;
  concern?: string;
  mileageIn?: number;
  vehicle?: unknown;
}

export async function upsertAutoVitalsAppointment(
  appointment: AutoVitalsAppointmentUpsertInput,
  shopId: string,
): Promise<void> {
  if (isAutovitalsCachePgCanonical()) {
    await pg.upsertAutoVitalsAppointment(appointment, shopId);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoAutovitalsCache,
      "autovitals.appointments.upsert",
      () => upsertAutoVitalsAppointmentMongo(appointment, shopId),
    );
    return;
  }
  await upsertAutoVitalsAppointmentMongo(appointment, shopId);
}

async function upsertAutoVitalsAppointmentMongo(
  appointment: AutoVitalsAppointmentUpsertInput,
  shopId: string,
): Promise<void> {
  const col = await collection();
  const now = new Date();
  await col.updateOne(
    { appointmentId: appointment.appointmentId, shopId },
    {
      $set: { ...appointment, shopId, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

export async function findLatestAppointmentForVehicle(
  shopId: string,
  vehicleId: number,
): Promise<AutoVitalsAppointmentCacheDoc | null> {
  if (isAutovitalsCachePgCanonical()) {
    return (await pg.findLatestAppointmentForVehicle(
      shopId,
      vehicleId,
    )) as AutoVitalsAppointmentCacheDoc | null;
  }
  const col = await collection();
  return col.findOne(
    { shopId, vehicleId },
    { sort: { updatedAt: -1 } },
  );
}

export async function countAutoVitalsAppointments(
  shopId: string,
): Promise<number> {
  if (isAutovitalsCachePgCanonical()) {
    return pg.countAutoVitalsAppointments(shopId);
  }
  const col = await collection();
  return col.countDocuments({ shopId });
}

/**
 * Delete every appointment row for a shop (dev "clear vehicles" tool).
 * Mongo matches both the string and numeric spellings of shopId — the
 * cache historically wrote the string form but older rows may carry the
 * number. Returns the number of docs removed.
 */
export async function deleteAutoVitalsAppointmentsForShop(
  shopId: number,
): Promise<number> {
  if (isAutovitalsCachePgCanonical()) {
    const removed = await pg.deleteAutoVitalsAppointmentsForShop(shopId);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoAutovitalsCache,
      "autovitals.appointments.deleteForShop",
      () => deleteAutoVitalsAppointmentsForShopMongo(shopId),
    );
    return removed;
  }
  return deleteAutoVitalsAppointmentsForShopMongo(shopId);
}

async function deleteAutoVitalsAppointmentsForShopMongo(
  shopId: number,
): Promise<number> {
  const col = await collection();
  const result = await col.deleteMany({
    $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) as any }],
  });
  return result.deletedCount ?? 0;
}
