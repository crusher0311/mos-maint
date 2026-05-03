// Repository for the `autovitals_inspections` collection.
//
// Caches AutoVitals inspection results keyed by (appointmentId, shopId).
// `shopId` is stored as a string.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "autovitals_inspections";

export interface AutoVitalsInspectionCacheDoc extends Document {
  appointmentId: number;
  shopId: string;
  inspectionResultId?: number;
  completedAt?: string;
  technicianId?: number;
  technicianName?: string;
  items?: any[];
  updatedAt?: Date;
  createdAt?: Date;
}

async function collection(): Promise<Collection<AutoVitalsInspectionCacheDoc>> {
  const db = await getDb();
  return db.collection<AutoVitalsInspectionCacheDoc>(COLLECTION);
}

export interface AutoVitalsInspectionUpsertInput {
  appointmentId: number;
  inspectionResultId?: number;
  completedAt?: string;
  technicianId?: number;
  technicianName?: string;
  items?: unknown[];
}

export async function upsertAutoVitalsInspection(
  inspection: AutoVitalsInspectionUpsertInput,
  shopId: string,
): Promise<void> {
  const col = await collection();
  const now = new Date();
  await col.updateOne(
    { appointmentId: inspection.appointmentId, shopId },
    {
      $set: { ...inspection, shopId, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

export async function findAutoVitalsInspection(
  appointmentId: number,
  shopId: string,
): Promise<AutoVitalsInspectionCacheDoc | null> {
  const col = await collection();
  return col.findOne({ appointmentId, shopId });
}
