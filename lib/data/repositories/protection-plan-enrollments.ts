// Repository for the `protection_plan_enrollments` collection (task #804).
//
// One row per (shopId, VIN, providerId): a shop-side record that a vehicle
// is enrolled in a chemical provider's protection plan (e.g. BG Lifetime
// Protection Plan). Deliberately a dedicated store — NOT a field on the
// legacy `vehicles` collection — so enrollment survives vehicle re-imports
// and never entangles with sync writers.
//
// Enrollment is advisory metadata only: it never feeds plan math. Readers
// use it for default-tab selection, badges and the shop roster report.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "protection_plan_enrollments";

export interface ProtectionPlanEnrollmentDoc extends Document {
  shopId: number;
  /** Always stored upper-cased. */
  vin: string;
  /** Chemical provider id from `maintenance.chemicalProviders` (e.g. "bg"). */
  providerId: string;
  /** Display name snapshot at enrollment time (provider may be renamed later). */
  providerName?: string;
  enrolledAt: Date;
  /** Email of the advisor who recorded the enrollment. */
  enrolledBy?: string | null;
  notes?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

async function collection(): Promise<Collection<ProtectionPlanEnrollmentDoc>> {
  const db = await getDb();
  return db.collection<ProtectionPlanEnrollmentDoc>(COLLECTION);
}

/** All enrollments for one vehicle in one shop (usually 0 or 1). */
export async function listEnrollmentsForVehicle(
  shopId: number,
  vin: string,
): Promise<ProtectionPlanEnrollmentDoc[]> {
  const col = await collection();
  return col
    .find({ shopId: Number(shopId), vin: vin.toUpperCase() })
    .sort({ enrolledAt: -1 })
    .toArray();
}

/** All enrollments for a shop (roster report). Bounded — one row per VIN+provider. */
export async function listEnrollmentsForShop(
  shopId: number,
  limit = 2000,
): Promise<ProtectionPlanEnrollmentDoc[]> {
  const col = await collection();
  return col
    .find({ shopId: Number(shopId) })
    .sort({ enrolledAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Records (or re-records) an enrollment. Idempotent upsert keyed by
 * (shopId, vin, providerId); re-enrolling refreshes enrolledAt/notes.
 */
export async function enrollVehicle(args: {
  shopId: number;
  vin: string;
  providerId: string;
  providerName?: string;
  enrolledBy?: string | null;
  notes?: string | null;
}): Promise<void> {
  const col = await collection();
  const now = new Date();
  await col.updateOne(
    {
      shopId: Number(args.shopId),
      vin: args.vin.toUpperCase(),
      providerId: args.providerId,
    },
    {
      $set: {
        shopId: Number(args.shopId),
        vin: args.vin.toUpperCase(),
        providerId: args.providerId,
        providerName: args.providerName ?? args.providerId,
        enrolledAt: now,
        enrolledBy: args.enrolledBy ?? null,
        notes: args.notes ?? null,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

/** Removes an enrollment record. Returns true when a record was deleted. */
export async function unenrollVehicle(
  shopId: number,
  vin: string,
  providerId: string,
): Promise<boolean> {
  const col = await collection();
  const res = await col.deleteOne({
    shopId: Number(shopId),
    vin: vin.toUpperCase(),
    providerId,
  });
  return res.deletedCount > 0;
}
