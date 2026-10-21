import type { Db } from "mongodb";
import type { ProtractorVehicle } from "./client";
import { bumpDashboardUpdate } from "@/lib/dashboard-updates";

/** Publish the refresh marker only after the dashboard's vehicle cache is durable. */
export async function saveVehicleSnapshot(
  db: Db, shopId: number, vin: string, vehicle: ProtractorVehicle,
): Promise<void> {
  const now = new Date();
  await db.collection("protractor_vehicles").updateOne(
    { shopId, vin: vin.toUpperCase() },
    {
      $set: {
        shopId, vin: vin.toUpperCase(), protractorId: vehicle.ID,
        year: vehicle.Year ?? null, make: vehicle.Make ?? null,
        model: vehicle.Model ?? null, color: vehicle.Color ?? null,
        engine: vehicle.Engine ?? null, transmission: vehicle.Transmission ?? null,
        odometer: vehicle.Usage ?? vehicle.Odometer ?? null,
        odometerDate: vehicle.OdometerDate ?? null,
        licensePlate: vehicle.LicensePlate ?? null, ownerId: vehicle.OwnerID ?? null,
        fetchedAt: now, source: "protractor",
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  // A failed notification must remain retryable; do not acknowledge it as complete.
  await bumpDashboardUpdate(db, "protractor-vehicle", shopId);
}
