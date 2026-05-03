// Repository for the `autovitals_appointments` collection.
//
// Caches AutoVitals appointments keyed by (appointmentId, shopId).
// `shopId` is stored as a string.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";

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
  const col = await collection();
  return col.findOne(
    { shopId, vehicleId },
    { sort: { updatedAt: -1 } },
  );
}
