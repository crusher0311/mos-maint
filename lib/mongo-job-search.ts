import type { Db } from "mongodb";
import { expandTokenVariants } from "@/lib/job-scoring";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Legacy Mongo `job_index` arm, restored as a fallback for the two job-search
 * routes (extension side panel + dashboard) per task #359. In practice this arm
 * also *serves* enterprise multi-location searches: the canonical Postgres arm
 * takes ~16s for those, so `searchJobsCombined` gives PG only a short grace
 * window and then serves these (sub-second) Mongo results instead.
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
  if (limit <= 0) return [];

  // Cap concurrent per-shop aggregates so a large enterprise shop list can't
  // burst the shared Mongo cluster (fleet-wide saturation has caused outages
  // before). Enterprises are typically well under this, so it rarely batches.
  const MAX_CONCURRENT_SHOP_QUERIES = 6;

  // Build the (token + make/model) match for a specific set of shopId variants.
  // Donor keywords are indexed as the literal lowercased words from each title
  // with no stemming, so an exact `$all` lookup misses simple singular/plural
  // variations ("brake pad" vs indexed "pads"). Expand each token to its small
  // variant set and require that EVERY token has at least one variant present.
  // Single-token queries collapse to a fast `$in` against the existing
  // `(shopId, job.keywords)` index; multi-token queries become `$and` of
  // per-token `$in` clauses, which the planner handles efficiently.
  const buildMatch = (shopIdVariants: (number | string)[]): Record<string, any> => {
    const matchStage: Record<string, any> = { shopId: { $in: shopIdVariants } };
    if (coreTokens.length > 0) {
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
    return matchStage;
  };

  // NOTE: do NOT add a DB-side `$sort: { performedAt: -1 }` to any of these
  // queries. Measured against live enterprise data (June 2026), the date-sort
  // makes the query ~160x slower (~22s vs ~0.1s) and guarantees a timeout for
  // multi-location shops. Instead we fetch the bounded match set (`$limit` only)
  // and order it by date in application code — the set is already small.
  const sortByPerformedAtDesc = (docs: any[]): void => {
    docs.sort((a, b) => {
      const ta = a.performedAt ? new Date(a.performedAt).getTime() : 0;
      const tb = b.performedAt ? new Date(b.performedAt).getTime() : 0;
      return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
    });
  };

  try {
    // Single shop: nothing to balance — one bounded fetch, ordered in app code.
    if (searchShopIds.length === 1) {
      const variants = [Number(searchShopIds[0]), String(searchShopIds[0])];
      const docs = await db
        .collection("job_index")
        .aggregate([{ $match: buildMatch(variants) }, { $limit: limit }], { maxTimeMS: 8000 })
        .toArray();
      sortByPerformedAtDesc(docs);
      return docs.map((d) => ({ ...d, dataSource: "job_index" }));
    }

    // Enterprise (multi-shop): fetch a fair, bounded slice PER shop in parallel,
    // then round-robin merge. Previously this ran a single `$match` across all
    // shops with one global `$limit`, so whichever location the index yielded
    // first (typically the busiest / most-recently-ingested shop) filled the
    // entire result window and starved every other location — the extension
    // showed "all one location". This mirrors the Postgres arm's
    // ROW_NUMBER-per-shop fairness, and matters here because enterprise PG
    // queries exceed the combined-search grace window so THIS arm is what
    // actually serves enterprise searches.
    const perShopLimit = Math.max(8, Math.ceil(limit / searchShopIds.length));
    const fetchShop = async (shopId: number): Promise<any[]> => {
      try {
        const variants = [Number(shopId), String(shopId)];
        const docs = await db
          .collection("job_index")
          .aggregate([{ $match: buildMatch(variants) }, { $limit: perShopLimit }], { maxTimeMS: 8000 })
          .toArray();
        sortByPerformedAtDesc(docs);
        return docs;
      } catch (err) {
        console.log(`[Mongo Job Search] Per-shop fetch failed (shop ${shopId}):`, (err as Error).message);
        return [] as any[];
      }
    };

    // Run in bounded-concurrency batches, preserving shop order so the
    // round-robin interleave below stays deterministic.
    const perShopDocs: any[][] = new Array(searchShopIds.length);
    for (let i = 0; i < searchShopIds.length; i += MAX_CONCURRENT_SHOP_QUERIES) {
      const batch = searchShopIds.slice(i, i + MAX_CONCURRENT_SHOP_QUERIES);
      const batchDocs = await Promise.all(batch.map((shopId) => fetchShop(shopId)));
      for (let j = 0; j < batchDocs.length; j++) perShopDocs[i + j] = batchDocs[j];
    }

    // Round-robin interleave so every shop's most-recent jobs land before any
    // single shop's deeper history, then cap at the overall limit. This keeps
    // the global cap from re-introducing single-shop bias.
    const merged: any[] = [];
    let depth = 0;
    let addedAtDepth = true;
    while (addedAtDepth && merged.length < limit) {
      addedAtDepth = false;
      for (const docs of perShopDocs) {
        if (depth < docs.length) {
          merged.push(docs[depth]);
          addedAtDepth = true;
          if (merged.length >= limit) break;
        }
      }
      depth++;
    }

    return merged.map((d) => ({ ...d, dataSource: "job_index" }));
  } catch (err) {
    console.log("[Mongo Job Search] Error:", (err as Error).message);
    return [];
  }
}
