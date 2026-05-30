// Repository for the `autovitals_vehicles` collection.
//
// Caches AutoVitals vehicle records keyed by (vehicleId, shopId).
// `shopId` is stored as a string here (matches the rest of the
// AutoVitals cache collections).
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isAutovitalsCachePgCanonical,
  shouldShadowWriteMongoAutovitalsCache,
  shadowWriteMongoIntegrationCache,
} from "@/lib/db/integration-cache-write-mode";
import * as pg from "./pg/autovitals-cache";

const COLLECTION = "autovitals_vehicles";

export interface AutoVitalsVehicleCacheDoc extends Document {
  vehicleId: number;
  shopId: string;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  mileage?: number;
  licensePlate?: string;
  color?: string;
  customerId?: number;
  customerName?: string;
  updatedAt?: Date;
  createdAt?: Date;
}

async function collection(): Promise<Collection<AutoVitalsVehicleCacheDoc>> {
  const db = await getDb();
  return db.collection<AutoVitalsVehicleCacheDoc>(COLLECTION);
}

export interface AutoVitalsVehicleUpsertInput {
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
}

export async function upsertAutoVitalsVehicle(
  vehicle: AutoVitalsVehicleUpsertInput,
  shopId: string,
): Promise<void> {
  if (isAutovitalsCachePgCanonical()) {
    await pg.upsertAutoVitalsVehicle(vehicle, shopId);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoAutovitalsCache,
      "autovitals.vehicles.upsert",
      () => upsertAutoVitalsVehicleMongo(vehicle, shopId),
    );
    return;
  }
  await upsertAutoVitalsVehicleMongo(vehicle, shopId);
}

async function upsertAutoVitalsVehicleMongo(
  vehicle: AutoVitalsVehicleUpsertInput,
  shopId: string,
): Promise<void> {
  const col = await collection();
  const now = new Date();
  await col.updateOne(
    { vehicleId: vehicle.vehicleId, shopId },
    {
      $set: { ...vehicle, shopId, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

export async function findAutoVitalsVehicleByVin(
  vin: string,
  shopId: string,
): Promise<AutoVitalsVehicleCacheDoc | null> {
  if (isAutovitalsCachePgCanonical()) {
    return (await pg.findAutoVitalsVehicleByVin(
      vin,
      shopId,
    )) as AutoVitalsVehicleCacheDoc | null;
  }
  const col = await collection();
  return col.findOne({ vin, shopId });
}

/**
 * Case-insensitive VIN lookup used by the inspection-by-VIN flow.
 */
export async function findAutoVitalsVehicleByVinCaseInsensitive(
  vinUpper: string,
  shopId: string,
): Promise<AutoVitalsVehicleCacheDoc | null> {
  if (isAutovitalsCachePgCanonical()) {
    return (await pg.findAutoVitalsVehicleByVinCaseInsensitive(
      vinUpper,
      shopId,
    )) as AutoVitalsVehicleCacheDoc | null;
  }
  const col = await collection();
  return col.findOne({
    shopId,
    vin: { $regex: new RegExp(`^${vinUpper}$`, "i") },
  });
}
