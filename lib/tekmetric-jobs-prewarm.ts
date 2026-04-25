import pLimit from "p-limit";
import { getDb } from "@/lib/mongo";
import { getRepairOrders, getJobs } from "@/lib/tekmetric";
import { cacheJobs } from "@/lib/tekmetric-incremental-sync";
import { maybeAlertOnPrewarmAnomalies } from "@/lib/tekmetric-jobs-prewarm-alerter";

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

  console.log(
    `[Tekmetric Prewarm] Shop ${shopId}: ${terminalRoIds.length} terminal RO(s) in window, ${cachedSet.size} already cached, fetching ${toFetch.length} (concurrency=${concurrency})`
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

  result.durationMs = Date.now() - start;

  console.log(
    `[Tekmetric Prewarm] Shop ${shopId} done: scanned=${result.rosScanned} terminal=${result.terminalRosFound} alreadyCached=${result.alreadyCached} cached=${result.rosCached} jobs=${result.jobsCached} errors=${result.errors} capped=${result.capped} ${result.durationMs}ms`
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
    await db.collection("shops").updateOne(
      { shopId: { $in: [shopId, String(shopId)] } },
      {
        $set: {
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
          },
        },
      }
    );
  } catch (err: any) {
    console.warn(
      `[Tekmetric Prewarm] Shop ${shopId}: failed to stamp shop status: ${err?.message || err}`
    );
  }
}
