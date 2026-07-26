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

/**
 * Task #804: distinct historical job names for one vehicle, used by the
 * protection-plan eligibility detector (provider-branded job matching).
 *
 * VIN is matched exactly (upper + raw casing variants — never regex, see
 * the COLLSCAN incident notes) across the two writer shapes
 * (`vehicle.vin` for Protractor rows, top-level `vin` for Tekmetric).
 * `shopId` is matched as both Number and String because legacy writers
 * stored either.
 */
export async function listJobNamesForVehicle(
  shopId: number,
  vin: string,
  limit = 300,
): Promise<string[]> {
  const normVin = vin.toUpperCase();
  const vinValues = normVin === vin ? [normVin] : [normVin, vin];
  const col = await collection();
  const rows = await col
    .find(
      {
        shopId: { $in: [Number(shopId), String(shopId)] },
        $or: [
          { "vehicle.vin": { $in: vinValues } },
          { vin: { $in: vinValues } },
        ],
      } as unknown as Filter<JobIndexDoc>,
      { projection: { jobName: 1, "job.title": 1, performedAt: 1 } },
    )
    .sort({ performedAt: -1 })
    .limit(limit)
    .toArray();

  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows as Array<JobIndexDoc & { jobName?: string }>) {
    const name = (row.jobName || row.job?.title || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * Task #804: shop-wide scan for provider-branded job rows, used by the
 * protection-plan roster to find eligible-but-not-enrolled vehicles.
 *
 * The regex runs over the shopId-bounded slice (indexed), newest-first
 * with a hard row limit — acceptable for an on-demand report page.
 * Tokens are already lowercase brand words ("bg"); the pattern anchors
 * word boundaries so "bg" never matches inside "bag".
 */
export async function listBrandedJobRowsForShop(
  shopId: number,
  brandTokens: string[],
  limit = 2000,
): Promise<Array<{ vin: string; name: string; performedAt: Date | null }>> {
  if (brandTokens.length === 0) return [];
  const escaped = brandTokens.map((t) =>
    t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = `(^|[^a-zA-Z0-9])(${escaped.join("|")})([^a-zA-Z0-9]|$)`;
  const col = await collection();
  const rows = await col
    .find(
      {
        shopId: { $in: [Number(shopId), String(shopId)] },
        $or: [
          { jobName: { $regex: pattern, $options: "i" } },
          { "job.title": { $regex: pattern, $options: "i" } },
        ],
      } as unknown as Filter<JobIndexDoc>,
      {
        projection: {
          _id: 0,
          jobName: 1,
          "job.title": 1,
          "vehicle.vin": 1,
          vin: 1,
          performedAt: 1,
        },
      },
    )
    .sort({ performedAt: -1 })
    .limit(limit)
    // Task #945: the regex $or can only be satisfied by walking the
    // shopId-bounded slice; on a very large shop that walk must never be
    // allowed to run unbounded on the shared cluster. The limit caps rows
    // RETURNED, maxTimeMS caps the scan itself — the report page degrades
    // (partial roster) instead of saturating Mongo fleet-wide.
    .maxTimeMS(8000)
    .toArray();

  const out: Array<{ vin: string; name: string; performedAt: Date | null }> = [];
  for (const row of rows as Array<
    JobIndexDoc & { jobName?: string; vin?: string }
  >) {
    const vin = ((row.vehicle?.vin || row.vin || "") as string).toUpperCase();
    const name = (row.jobName || row.job?.title || "").trim();
    if (!vin || vin.length < 11 || !name) continue;
    out.push({
      vin,
      name,
      performedAt: row.performedAt instanceof Date ? row.performedAt : null,
    });
  }
  return out;
}
