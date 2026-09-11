/**
 * Read-only cache access for Estimate Assist recommendation resolution.
 *
 * The resolver intentionally owns matching/scoring, while this repository owns
 * every Mongo read needed to assemble already-populated provider catalogs and
 * shop history preferences. `dbOverride` is a test seam: resolver smoke tests
 * can keep using their fake DB without reopening a real connection.
 */
import type { Db } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  searchJobsCombined,
  type CombinedJobSearchOptions,
  type CombinedJobSearchResult,
} from "@/lib/job-search-combined";
import { findEnrichedCannedJobs } from "./canned-jobs";

type AnyRecord = Record<string, any>;

export interface RecommendationCachedCatalog {
  sourceSystem: string;
  shopId: number;
  items: AnyRecord[];
  fetchedAt?: Date | string | null;
  source?: string | null;
  listSource?: string | null;
}

interface RecommendationReadOptions {
  dbOverride?: Db;
}

export interface RecommendationHistoryReadOptions extends CombinedJobSearchOptions {
  /**
   * Resolver smoke-test seam. Production callers leave this unset so the
   * repository uses the canonical combined search implementation.
   */
  searchJobsCombined?: typeof searchJobsCombined;
  /**
   * Resolver smoke-test seam. When omitted, acquire the real Mongo handle
   * here rather than passing a nullable application-level handle downstream.
   */
  dbOverride?: Db;
}

export const __deps = {
  getDb,
  searchJobsCombined,
};

async function findOne(
  db: Db,
  collectionName: string,
  filter: AnyRecord,
  options?: AnyRecord,
): Promise<AnyRecord | null> {
  const collection = db.collection(collectionName);
  if (typeof collection.findOne !== "function") return null;
  return collection.findOne(filter, options) as Promise<AnyRecord | null>;
}

/**
 * Reads provider caches only. No provider list or detail endpoint is called.
 * The canonical-store read for `canned_jobs` is delegated to
 * findEnrichedCannedJobs so the PG migration flag remains authoritative.
 */
export async function findRecommendationCachedCatalogs(
  shopId: number,
  options: RecommendationReadOptions = {},
): Promise<RecommendationCachedCatalog[]> {
  const db = options.dbOverride || await getDb();
  const catalogs: RecommendationCachedCatalog[] = [];

  const protractorExtension = await findOne(db, "protractor_canned_jobs_cache", { shopId });
  if (protractorExtension && Array.isArray(protractorExtension.cannedJobs)) {
    catalogs.push({
      sourceSystem: "protractor",
      shopId,
      items: protractorExtension.cannedJobs,
      fetchedAt: protractorExtension.fetchedAt,
      source: "extension_cache",
      listSource: protractorExtension.listSource || null,
    });
  }

  // Tekmetric's cache may be keyed by either its upstream location id or the
  // MOS shop id. Preserve the MOS id in the catalog identity.
  const shop = await findOne(
    db,
    "shops",
    { shopId: { $in: [shopId, String(shopId)] } },
    { projection: { tekmetric: 1, tekmetricShopId: 1 } },
  );
  const tekmetricShopId = shop?.tekmetric?.shopId || shop?.tekmetricShopId;
  const tekmetricCache = await findOne(db, "tekmetric_canned_jobs_cache", {
    $or: [
      { shopId },
      ...(tekmetricShopId != null
        ? [{ shopId: Number(tekmetricShopId) }, { shopId: String(tekmetricShopId) }]
        : []),
      { mosShopId: shopId },
    ],
  });
  if (tekmetricCache) {
    const items = Array.isArray(tekmetricCache.cannedJobs)
      ? tekmetricCache.cannedJobs
      : Array.isArray(tekmetricCache.items)
        ? tekmetricCache.items
        : [];
    if (items.length > 0) {
      catalogs.push({
        sourceSystem: "tekmetric",
        shopId,
        items,
        fetchedAt: tekmetricCache.fetchedAt,
        source: tekmetricCache.source || "cache",
      });
    }
  }

  for (const sourceSystem of ["autoflow", "shopware", "shopmonkey"]) {
    const providerCache = await findOne(db, `${sourceSystem}_canned_jobs_cache`, { shopId });
    const items = Array.isArray(providerCache?.items)
      ? providerCache.items
      : Array.isArray(providerCache?.cannedJobs)
        ? providerCache.cannedJobs
        : Array.isArray(providerCache?.jobs)
          ? providerCache.jobs
          : [];
    if (items.length > 0) {
      catalogs.push({
        sourceSystem,
        shopId,
        items,
        fetchedAt: providerCache?.fetchedAt || providerCache?.cachedAt,
        source: providerCache?.source || "cache",
        listSource: providerCache?.listSource || null,
      });
    }
  }

  const enriched = await findEnrichedCannedJobs(shopId, { dbOverride: db, limit: 500 });
  if (Array.isArray(enriched) && enriched.length > 0) {
    const byProvider = new Map<string, AnyRecord[]>();
    for (const item of enriched) {
      const record = item as AnyRecord;
      const provider = String(
        record?.sourceSystem ??
        record?.provider ??
        record?.integration ??
        record?.provenance?.sourceSystem ??
        "catalog",
      ).trim().toLowerCase() || "catalog";
      const current = byProvider.get(provider) || [];
      current.push(record);
      byProvider.set(provider, current);
    }
    for (const [sourceSystem, items] of byProvider) {
      catalogs.push({ sourceSystem, shopId, items, source: "enriched_cache" });
    }
  }

  return catalogs;
}

export async function findRecommendationShopPreferences(
  shopId: number,
  options: RecommendationReadOptions = {},
): Promise<AnyRecord | null> {
  const db = options.dbOverride || await getDb();
  const shop = await findOne(
    db,
    "shops",
    { shopId: { $in: [shopId, String(shopId)] } },
    { projection: { preferences: 1 } },
  );
  return shop?.preferences || null;
}

/**
 * Runs the bounded history search after acquiring its Mongo dependency.
 *
 * The resolver's `getDb` seam may intentionally return null in production;
 * that must not become the Mongo argument to searchJobsCombined. Supplying
 * `dbOverride` keeps the existing fake-DB smoke seams intact, while normal
 * calls acquire the real handle in this repository.
 */
export async function searchRecommendationHistory(
  shopIds: number[],
  coreTokens: string[],
  options: RecommendationHistoryReadOptions,
): Promise<CombinedJobSearchResult> {
  const db = options.dbOverride || await __deps.getDb();
  const search = options.searchJobsCombined || __deps.searchJobsCombined;
  const {
    dbOverride: _dbOverride,
    searchJobsCombined: _searchJobsCombined,
    ...searchOptions
  } = options;
  return search(db, shopIds, coreTokens, searchOptions);
}
