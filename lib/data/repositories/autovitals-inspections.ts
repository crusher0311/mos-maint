// Repository for the `autovitals_inspections` collection.
//
// Caches AutoVitals inspection results keyed by (appointmentId, shopId).
// `shopId` is stored as a string.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isAutovitalsCachePgCanonical,
  shouldShadowWriteMongoAutovitalsCache,
  shadowWriteMongoIntegrationCache,
} from "@/lib/db/integration-cache-write-mode";
import * as pg from "./pg/autovitals-cache";

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

export type AutoVitalsInspectionUpsertInput = {
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
  if (isAutovitalsCachePgCanonical()) {
    await pg.upsertAutoVitalsInspection(inspection, shopId);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoAutovitalsCache,
      "autovitals.inspections.upsert",
      () => upsertAutoVitalsInspectionMongo(inspection, shopId),
    );
    return;
  }
  await upsertAutoVitalsInspectionMongo(inspection, shopId);
}

async function upsertAutoVitalsInspectionMongo(
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
  if (isAutovitalsCachePgCanonical()) {
    return (await pg.findAutoVitalsInspection(
      appointmentId,
      shopId,
    )) as AutoVitalsInspectionCacheDoc | null;
  }
  const col = await collection();
  return col.findOne({ appointmentId, shopId });
}

export async function findLatestInspectionForAppointment(
  shopId: string,
  appointmentId: number,
): Promise<AutoVitalsInspectionCacheDoc | null> {
  if (isAutovitalsCachePgCanonical()) {
    return (await pg.findLatestInspectionForAppointment(
      shopId,
      appointmentId,
    )) as AutoVitalsInspectionCacheDoc | null;
  }
  const col = await collection();
  return col.findOne(
    { shopId, appointmentId },
    { sort: { updatedAt: -1 } },
  );
}

export async function countAutoVitalsInspections(
  shopId: string | number,
): Promise<number> {
  if (isAutovitalsCachePgCanonical()) {
    return pg.countAutoVitalsInspections(String(shopId));
  }
  const col = await collection();
  return col.countDocuments({ shopId } as Document);
}

/**
 * Insert a browser-extension DVI capture (task: AutoVitals extension).
 * Unlike `upsertAutoVitalsInspection`, this is a raw insert of a
 * differently-shaped doc (no appointmentId; carries vin/source/results)
 * and returns the new document id so the caller can stamp the vehicle's
 * `lastDviId`.
 */
export async function insertAutoVitalsInspectionDoc(
  doc: Record<string, unknown>,
): Promise<unknown> {
  if (isAutovitalsCachePgCanonical()) {
    const id = await pg.insertAutoVitalsInspectionDoc(doc);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoAutovitalsCache,
      "autovitals.inspections.insertDoc",
      () => insertAutoVitalsInspectionDocMongo(doc),
    );
    return id;
  }
  return insertAutoVitalsInspectionDocMongo(doc);
}

async function insertAutoVitalsInspectionDocMongo(
  doc: Record<string, unknown>,
): Promise<unknown> {
  const col = await collection();
  const result = await col.insertOne(doc as AutoVitalsInspectionCacheDoc);
  return result.insertedId;
}
