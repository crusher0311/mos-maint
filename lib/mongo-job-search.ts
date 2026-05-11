import type { Db } from "mongodb";
import { expandTokenVariants } from "@/lib/job-scoring";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Legacy Mongo `job_index` arm, restored as a fallback for the two job-search
 * routes (extension side panel + dashboard) per task #359. Used only when the
 * primary Supabase arm (`searchSupabaseServiceJobs`) returns an empty set,
 * because the upstream PG ingestion that populates `normalized_service_jobs`
 * was never wired up after task #299. Once that ingestion gap is closed and
 * PG starts serving non-empty results, this fallback becomes dormant
 * automatically and can be retired.
 *
 * Returned documents preserve the legacy `job_index` shape, which the
 * downstream scoring/formatting in both routes already understands (it is
 * what those routes consumed before #299).
 */
export async function searchMongoJobIndex(
  db: Db,
  searchShopIds: number[],
  coreTokens: string[],
  vehicleMake?: string,
  limit: number = 50,
  vehicleModel?: string,
  strictModel: boolean = false,
): Promise<any[]> {
  if (searchShopIds.length === 0) return [];
  // Mirror the supabase guard: refuse unbounded queries (no tokens AND no make).
  if (coreTokens.length === 0 && !vehicleMake) return [];

  const shopIdVariants = searchShopIds.flatMap((id) => [Number(id), String(id)]);
  const matchStage: Record<string, any> = {
    shopId: { $in: shopIdVariants },
  };

  if (coreTokens.length > 0) {
    // Donor keywords are indexed as the literal lowercased words from each
    // title with no stemming, so an exact `$all` lookup misses simple
    // singular/plural variations ("brake pad" vs indexed "pads"). Expand each
    // token to its small variant set and require that EVERY token has at
    // least one variant present in the keywords array. Single-token queries
    // collapse to a fast `$in` against the existing `(shopId, job.keywords)`
    // index; multi-token queries become `$and` of per-token `$in` clauses,
    // which the planner handles efficiently.
    if (coreTokens.length === 1) {
      matchStage["job.keywords"] = { $in: expandTokenVariants(coreTokens[0]) };
    } else {
      matchStage["$and"] = coreTokens.map((t) => ({
        "job.keywords": { $in: expandTokenVariants(t) },
      }));
    }
  }
  if (vehicleMake) {
    matchStage["vehicle.make"] = { $regex: escapeRegex(vehicleMake), $options: "i" };
  }
  if (strictModel && vehicleModel) {
    matchStage["vehicle.model"] = { $regex: `^${escapeRegex(vehicleModel)}$`, $options: "i" };
  }

  try {
    const docs = await db
      .collection("job_index")
      .aggregate(
        [
          { $match: matchStage },
          { $sort: { performedAt: -1 } },
          { $limit: limit },
        ],
        { maxTimeMS: 8000 },
      )
      .toArray();
    return docs.map((d) => ({ ...d, dataSource: "job_index" }));
  } catch (err) {
    console.log("[Mongo Job Search] Error:", (err as Error).message);
    return [];
  }
}
