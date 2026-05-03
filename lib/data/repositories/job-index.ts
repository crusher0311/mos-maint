// Repository for the `job_index` collection — narrow surface for the
// Protractor pricing-lookup paths.
//
// `job_index` is a large collection with many writers and indexers
// (see lib/job-index.ts, lib/tekmetric-job-index.ts, etc.). Those
// writer modules are still on the legacy allowlist; this repository
// only exposes the read shapes the Protractor integration needs to
// resolve jobs and pricing without reaching into the driver itself.
import type { Collection, Document, Filter } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "job_index";

export interface JobIndexDoc extends Document {
  shopId: number;
  job?: { title?: string; code?: string };
  vehicle?: { serviceItemId?: string; vin?: string };
  lines?: any[];
  performedAt?: Date;
  workOrderNumber?: number;
}

async function collection(): Promise<Collection<JobIndexDoc>> {
  const db = await getDb();
  return db.collection<JobIndexDoc>(COLLECTION);
}

/**
 * Returns the first job_index doc for the shop whose `job.title`
 * matches and which has at least one cached line.
 */
export async function findJobIndexByTitleWithLines(
  shopId: number,
  jobTitle: string,
): Promise<JobIndexDoc | null> {
  const col = await collection();
  return col.findOne({
    shopId,
    "job.title": jobTitle,
    lines: { $exists: true, $ne: [] },
  } as Filter<JobIndexDoc>);
}

/**
 * Lists the most-recent job_index docs for a vehicle in a shop, used
 * by the Protractor cached-pricing fallback (`findCachedJobPricing`).
 *
 * `vehicleConditions` is intentionally a list of Mongo filter fragments
 * — VIN can be cased differently across legacy writers, and callers
 * may only have a serviceItemId. The repository does not invent these
 * variants; the caller is the source of truth for which vehicle keys
 * to OR together.
 */
export async function listRecentJobIndexForVehicle(
  shopId: number,
  vehicleConditions: Array<Filter<JobIndexDoc>>,
  limit = 100,
): Promise<JobIndexDoc[]> {
  if (vehicleConditions.length === 0) return [];
  const col = await collection();
  return col
    .find({
      shopId,
      $or: vehicleConditions,
    } as Filter<JobIndexDoc>)
    .sort({ performedAt: -1 })
    .limit(limit)
    .toArray();
}
