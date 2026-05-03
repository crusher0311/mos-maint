// Repository for the `protractor_vehicles` collection.
//
// Cached snapshot of a Protractor service item / vehicle, keyed by
// (shopId, VIN). Two upsert flavors are exposed because the call sites
// have meaningfully different field shapes — a full snapshot from a
// raw `ProtractorVehicle`, and a partial vehicle update derived from a
// work-order `ServiceItem`.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "protractor_vehicles";

export interface ProtractorVehicleCacheDoc extends Document {
  shopId: number;
  vin: string;
  protractorId?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  color?: string | null;
  engine?: string | null;
  transmission?: string | null;
  odometer?: number | null;
  odometerDate?: string | null;
  licensePlate?: string | null;
  ownerId?: string | null;
  mileage?: number | null;
  fetchedAt?: Date;
  updatedAt?: Date;
  createdAt?: Date;
  source?: string;
}

async function collection(): Promise<Collection<ProtractorVehicleCacheDoc>> {
  const db = await getDb();
  return db.collection<ProtractorVehicleCacheDoc>(COLLECTION);
}

export async function findVehicleByShopAndVin(
  shopId: number,
  vin: string,
): Promise<ProtractorVehicleCacheDoc | null> {
  const col = await collection();
  return col.findOne({ shopId, vin: vin.toUpperCase() });
}

export type ProtractorVehicleUpsertFields = Partial<
  Omit<ProtractorVehicleCacheDoc, "createdAt">
>;

export async function upsertVehicleSnapshot(
  shopId: number,
  vin: string,
  set: ProtractorVehicleUpsertFields,
  now: Date,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId, vin: vin.toUpperCase() },
    {
      $set: set,
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}
