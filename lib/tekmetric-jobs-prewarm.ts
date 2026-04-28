import pLimit from "p-limit";
import { getDb } from "@/lib/mongo";
import { getRepairOrders, getJobs, type TekmetricJob } from "@/lib/tekmetric";
import { cacheJobs } from "@/lib/tekmetric-incremental-sync";
import { maybeAlertOnPrewarmAnomalies } from "@/lib/tekmetric-jobs-prewarm-alerter";
import {
  bulkCacheJobs,
  bulkFetchJobsByShopWindow,
  isBulkJobsPrewarmEnabled,
} from "@/lib/tekmetric-bulk-jobs";

// Terminal RO statuses whose `/jobs` payloads are stable after the fact —
// the same set the backfill consumer treats as cacheable. Anything else
// (active, in-progress) we deliberately skip: a non-terminal RO's jobs
// can still change, so caching them at onboarding time would risk handing
// the first backfill a stale answer.
const TERMINAL_STATUS_CODES = new Set([
  "POSTED",
  "INVOICED",
  "INVOICE",
  "COMPLETED",
]);

// Onboarding pre-warm scope. The first backfill chunk is the most recent
// `chunkDays` window (currently 90), so warming that window gives the very
// first chunk a near-100% cache-hit rate. We also cap the absolute number
// of /jobs calls so that a high-volume shop with thousands of recent ROs
// can't burn the entire Tekmetric quota in one onboarding pass — the
// uncached tail will still get warmed opportunistically by the regular
// indexing path (task #57) as the cron walks back through history.
const PREWARM_LOOKBACK_DAYS = 90;
const PREWARM_MAX_ROS = 500;
const PREWARM_PAGE_SIZE = 100;
const PREWARM_MAX_PAGES = 10;
const PREWARM_CONCURRENCY = 3;

// Mirror the freshness window used by `getCachedJobs` in
// lib/tekmetric-incremental-sync.ts (JOBS_CACHE_TTL_MS = 30d). We mirror
// rather than import the constant to avoid widening that module's
// surface; a regression here is caught the moment the backfill cron
// fails to hit a row this prewarm wrote.
const PREWARM_FRESH_CACHE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface PrewarmJobsCacheOptions {
  lookbackDays?: number;
  maxRos?: number;
  concurrency?: number;
}

export interface PrewarmJobsCacheResult {
  shopId: number;
  tekmetricShopId: number;
  lookbackDays: number;
  rosScanned: number;
  terminalRosFound: number;
  alreadyCached: number;
  rosCached: number;
  jobsCached: number;
  errors: number;
  durationMs: number;
  capped: boolean;
  // Bulk-path metrics (task #146). `bulkPagesFetched` counts paged
  // /jobs?shop=X&updatedDateStart=… calls actually issued; `apiCallsSaved`
  // is the per-RO call count this run AVOIDED vs. the legacy per-RO
  // shape (i.e. `toFetch.length - bulkPagesFetched`, floored at 0).
  // `bulkPath` records which path actually ran for the row — `"bulk"`
  // when the bulk shape was enabled (env kill-switch NOT set to
  // "false") and the bulk pull succeeded, `"per-ro"` for the legacy
  // fallback (kill-switch flipped off OR bulk pull threw).
  bulkPath: "bulk" | "per-ro";
  bulkPagesFetched: number;
  apiCallsSaved: number;
}

/**
 * One-shot pre-warm for `tekmetric_jobs_cache` at fresh-shop onboarding.
 *
 * Background: `tekmetric_jobs_cache` is otherwise warmed two ways —
 *   1. The incremental sync writes terminal RO jobs as it polls active ROs
 *      that flip terminal (lib/tekmetric-incremental-sync.ts:cacheJobs).
 *   2. Any `indexTekmetricWorkOrderJobs` call (webhook, poll, backfill)
 *      writes to the cache as a side effect (task #57).
 *
 * Neither covers a brand-new shop's *historical* terminal ROs: the shop
 * has no webhook history, and incremental sync only iterates active ROs.
 * So the very first backfill chunk for a freshly onboarded shop pays the
 * full per-RO `/jobs?repairOrderId=…` cost for every terminal RO in its
 * recent history. This helper bulk-fetches jobs for the shop's recent
 * terminal ROs and writes them to `tekmetric_jobs_cache` so the first
 * backfill chunk lands at cache-hit speed instead of cold-cache API
 * speed.
 *
 * Idempotent: repeated calls are safe because we skip ROs whose
 * `tekmetric_jobs_cache` row already exists. cacheJobs upserts.
 */
export async function prewarmTekmetricJobsCacheForOnboarding(
  shopId: number,
  tekmetricShopId: number,
  options: PrewarmJobsCacheOptions = {}
): Promise<PrewarmJobsCacheResult> {
  const lookbackDays = options.lookbackDays ?? PREWARM_LOOKBACK_DAYS;
  const maxRos = options.maxRos ?? PREWARM_MAX_ROS;
  const concurrency = options.concurrency ?? PREWARM_CONCURRENCY;

  const start = Date.now();
  const db = await getDb();
  const updatedDateStart = new Date(
    Date.now() - lookbackDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const result: PrewarmJobsCacheResult = {
    shopId,
    tekmetricShopId,
    lookbackDays,
    rosScanned: 0,
    terminalRosFound: 0,
    alreadyCached: 0,
    rosCached: 0,
    jobsCached: 0,
    errors: 0,
    durationMs: 0,
    capped: false,
    bulkPath: "per-ro",
    bulkPagesFetched: 0,
    apiCallsSaved: 0,
  };

  console.log(
    `[Tekmetric Prewarm] Shop ${shopId} (tek ${tekmetricShopId}): scanning ROs updated since ${updatedDateStart} (lookback=${lookbackDays}d, cap=${maxRos})`
  );

  const terminalRoIds: number[] = [];
  let page = 0;
  let listingPagesFetched = 0;

  while (page < PREWARM_MAX_PAGES && terminalRoIds.length < maxRos) {
    let response;
    try {
      response = await getRepairOrders(tekmetricShopId, {
        page,
        size: PREWARM_PAGE_SIZE,
        updatedDateStart,
        sortDirection: "DESC",
      });
      listingPagesFetched++;
    } catch (err: any) {
      console.warn(
        `[Tekmetric Prewarm] Shop ${shopId}: failed to list ROs page ${page}: ${err?.message || err}`
      );
      result.errors++;
      break;
    }

    const content = response?.content || [];
    result.rosScanned += content.length;

    for (const ro of content) {
      const code = (ro.repairOrderStatus?.code || "").toUpperCase();
      if (TERMINAL_STATUS_CODES.has(code)) {
        terminalRoIds.push(ro.id);
        if (terminalRoIds.length >= maxRos) {
          result.capped = true;
          break;
        }
      }
    }

    if (response.last) break;
    page++;
  }

  result.terminalRosFound = terminalRoIds.length;

  if (terminalRoIds.length === 0) {
    result.durationMs = Date.now() - start;
    console.log(
      `[Tekmetric Prewarm] Shop ${shopId}: no terminal ROs in last ${lookbackDays}d (${result.rosScanned} ROs scanned across ${listingPagesFetched} page(s)); nothing to warm`
    );
    await stampShopPrewarmStatus(db, shopId, result);
    // Even on the empty-ROs path the listing call itself can have errored
    // (we count list-page failures into result.errors); page on-call so a
    // freshly onboarded shop whose first listing page failed isn't left
    // looking like a clean warm.
    await tryEmitPrewarmAlert(db, shopId, tekmetricShopId, result);
    return result;
  }

  // Only treat *fresh* cache rows as "already cached". A row whose
  // `cachedAt` is past the jobs-cache TTL would be ignored by
  // `getCachedJobs` during backfill anyway (it filters on `cachedAt >
  // now - JOBS_CACHE_TTL_MS`), so skipping it here would leave the
  // backfill cold-cache for that RO. Re-warming a stale row is a safe
  // upsert.
  const freshCachedAtCutoff = new Date(
    Date.now() - PREWARM_FRESH_CACHE_WINDOW_MS
  );
  const existing = await db
    .collection("tekmetric_jobs_cache")
    .find(
      {
        repairOrderId: { $in: terminalRoIds },
        cachedAt: { $gt: freshCachedAtCutoff },
      },
      { projection: { repairOrderId: 1, _id: 0 } }
    )
    .toArray();
  const cachedSet = new Set<number>(
    existing.map((d: any) => Number(d.repairOrderId))
  );
  result.alreadyCached = cachedSet.size;

  const toFetch = terminalRoIds.filter((id) => !cachedSet.has(id));

  // Bulk shop-level path (task #146). The legacy per-RO shape would issue
  // `toFetch.length` /jobs?repairOrderId=… calls — for a fresh shop with
  // hundreds of terminal ROs in the lookback window, that's the dominant
  // cost of first-time history ingestion. The bulk shape pulls the same
  // jobs in shop-level pages of 100 (typically a 20-30x reduction in API
  // call count). The legacy per-RO path stays in place behind a kill-switch
  // (`TEKMETRIC_BULK_JOBS_PREWARM_ENABLED=false`) so a misbehaving bulk
  // shop can be flipped back to per-RO without a code deploy.
  const bulkEnabled = isBulkJobsPrewarmEnabled();
  let bulkSucceeded = false;

  if (bulkEnabled && toFetch.length > 0) {
    console.log(
      `[Tekmetric Prewarm] Shop ${shopId}: ${terminalRoIds.length} terminal RO(s) in window, ${cachedSet.size} already cached, bulk-fetching jobs for ${toFetch.length} RO(s) via /jobs?shop=X&updatedDateStart=…`
    );
    try {
      const updatedDateEnd = new Date().toISOString();
      const bulk = await bulkFetchJobsByShopWindow(tekmetricShopId, {
        updatedDateStart,
        updatedDateEnd,
      });
      result.bulkPath = "bulk";
      result.bulkPagesFetched = bulk.pagesFetched;
      // For each terminal RO we needed to fetch, write either the bulk
      // result OR an empty array. Caching empty is correct here: the
      // bulk pull's date filter matches the RO list filter exactly, so
      // a terminal RO with no jobs in the bulk response truly has no
      // jobs in the window. The backfill consumer treats empty as a
      // cache hit; the per-RO backfill fallback is the safety net for
      // the rare case where a job's updatedDate fell outside the
      // window.
      const cacheEntries: Array<{
        repairOrderId: number;
        jobs: TekmetricJob[];
      }> = [];
      let bulkRoHits = 0;
      let totalJobs = 0;
      for (const roId of toFetch) {
        const jobs = bulk.jobsByRoId.get(roId) || [];
        if (jobs.length > 0) bulkRoHits++;
        cacheEntries.push({ repairOrderId: roId, jobs });
        totalJobs += jobs.length;
      }
      try {
        await bulkCacheJobs(db, cacheEntries);
        result.rosCached = cacheEntries.length;
        result.jobsCached = totalJobs;
        // API calls saved this run vs. the legacy per-RO shape: each RO
        // would have cost one /jobs call; the bulk path replaced that with
        // `bulk.pagesFetched` paged shop-level calls. Floor at 0 so a
        // very small lookback (toFetch < pages) doesn't report a negative.
        result.apiCallsSaved = Math.max(
          0,
          toFetch.length - bulk.pagesFetched
        );
        bulkSucceeded = true;
        console.log(
          `[Tekmetric Prewarm] Shop ${shopId}: bulk path complete — pages=${bulk.pagesFetched} ros=${cacheEntries.length} (with-jobs=${bulkRoHits}, empty=${cacheEntries.length - bulkRoHits}) jobs=${totalJobs} ~apiCallsSaved=${result.apiCallsSaved}`
        );
      } catch (writeErr: any) {
        // Mongo write failure shouldn't fall back to per-RO API calls
        // (we already paid for the bulk fetch). Just record an error so
        // the alerter sees it and the next run will retry.
        result.errors++;
        console.warn(
          `[Tekmetric Prewarm] Shop ${shopId}: bulk cache write failed: ${writeErr?.message || writeErr}`
        );
        bulkSucceeded = true;
      }
    } catch (err: any) {
      // Bulk fetch threw — fall through to the per-RO loop below so the
      // shop still gets warmed (just at the slower per-RO API cost).
      result.errors++;
      console.warn(
        `[Tekmetric Prewarm] Shop ${shopId}: bulk fetch failed; falling back to per-RO path: ${err?.message || err}`
      );
    }
  }

  if (!bulkSucceeded) {
    console.log(
      `[Tekmetric Prewarm] Shop ${shopId}: ${terminalRoIds.length} terminal RO(s) in window, ${cachedSet.size} already cached, fetching ${toFetch.length} per-RO (concurrency=${concurrency}, bulkEnabled=${bulkEnabled})`
    );

    const limit = pLimit(concurrency);
    await Promise.all(
      toFetch.map((roId) =>
        limit(async () => {
          try {
            const jobsResp = await getJobs(tekmetricShopId, {
              repairOrderId: roId,
              size: 100,
            });
            const jobs = jobsResp.content || [];
            // Cache even empty arrays: an indexed terminal RO that
            // genuinely has no jobs is still a stable answer, and the
            // backfill consumer is set up to treat empty as a cache hit.
            await cacheJobs(db, roId, jobs);
            result.rosCached++;
            result.jobsCached += jobs.length;
          } catch (err: any) {
            result.errors++;
            console.warn(
              `[Tekmetric Prewarm] Shop ${shopId}: jobs fetch failed for RO ${roId}: ${err?.message || err}`
            );
          }
        })
      )
    );
  }

  result.durationMs = Date.now() - start;

  console.log(
    `[Tekmetric Prewarm] Shop ${shopId} done: scanned=${result.rosScanned} terminal=${result.terminalRosFound} alreadyCached=${result.alreadyCached} cached=${result.rosCached} jobs=${result.jobsCached} errors=${result.errors} capped=${result.capped} path=${result.bulkPath} bulkPages=${result.bulkPagesFetched} apiCallsSaved=${result.apiCallsSaved} ${result.durationMs}ms`
  );

  await stampShopPrewarmStatus(db, shopId, result);
  await tryEmitPrewarmAlert(db, shopId, tekmetricShopId, result);
  return result;
}

/**
 * Fire-and-forget wrapper around the alerter. The alerter handles its own
 * dedup and admin-lookup, but we still wrap it in try/catch so an alert
 * pipeline failure (Resend down, Mongo hiccup) can never break the
 * onboarding flow that called us.
 */
async function tryEmitPrewarmAlert(
  db: any,
  shopId: number,
  tekmetricShopId: number,
  result: PrewarmJobsCacheResult
): Promise<void> {
  // Capture the actual completion timestamp here so the alert email and
  // the persisted `shops.tekmetric.jobsCachePrewarm.completedAt` stamp
  // agree to the millisecond. The alerter would otherwise fall back to
  // `new Date()` at email render time, which can drift by the dedup
  // lookup + admin lookup + Resend round-trip.
  const completedAt = new Date();
  try {
    await maybeAlertOnPrewarmAnomalies(
      db,
      shopId,
      tekmetricShopId,
      result,
      completedAt
    );
  } catch (err: any) {
    console.warn(
      `[Tekmetric Prewarm] Shop ${shopId}: alert emit failed (non-fatal): ${err?.message || err}`
    );
  }
}

async function stampShopPrewarmStatus(
  db: any,
  shopId: number,
  result: PrewarmJobsCacheResult
): Promise<void> {
  try {
    // Per-shop opt-in for the backfill chunk's bulk pre-pass (task #146).
    // The prewarm runs at first-time onboarding and is itself the proof
    // that the bulk shape works on this shop, so on a successful bulk
    // prewarm we stamp `tekmetric.bulkJobsPrewarm.enabled = true` here.
    // The backfill cron reads this flag (via
    // `isBulkJobsPrewarmEnabledForShop`) and only does its bulk pre-pass
    // for shops that have it set — i.e. shops onboarded after this code
    // shipped. Existing shops (no flag) keep using the legacy per-RO
    // path until explicitly opted in.
    const $set: Record<string, any> = {
      "tekmetric.jobsCachePrewarm": {
        completedAt: new Date(),
        lookbackDays: result.lookbackDays,
        rosScanned: result.rosScanned,
        terminalRosFound: result.terminalRosFound,
        alreadyCached: result.alreadyCached,
        rosCached: result.rosCached,
        jobsCached: result.jobsCached,
        errors: result.errors,
        capped: result.capped,
        durationMs: result.durationMs,
        // Bulk-path metrics (task #146). Persisted so on-call can see
        // at a glance which path actually ran for a given shop and
        // how many per-RO API calls the bulk shape avoided. Existing
        // sync-health UI reads ignore these and keep working.
        bulkPath: result.bulkPath,
        bulkPagesFetched: result.bulkPagesFetched,
        apiCallsSaved: result.apiCallsSaved,
      },
    };
    if (result.bulkPath === "bulk" && result.errors === 0) {
      $set["tekmetric.bulkJobsPrewarm"] = {
        enabled: true,
        enabledAt: new Date(),
        // Record the prewarm result that opted this shop in so on-call
        // can audit who turned the flag on without grepping cron logs.
        enabledByPrewarm: {
          pagesFetched: result.bulkPagesFetched,
          rosCached: result.rosCached,
          jobsCached: result.jobsCached,
          apiCallsSaved: result.apiCallsSaved,
        },
      };
    }
    await db.collection("shops").updateOne(
      { shopId: { $in: [shopId, String(shopId)] } },
      { $set }
    );
  } catch (err: any) {
    console.warn(
      `[Tekmetric Prewarm] Shop ${shopId}: failed to stamp shop status: ${err?.message || err}`
    );
  }
}
