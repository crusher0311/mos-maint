import { getJobsByShopWindow, type TekmetricJob } from "@/lib/tekmetric";

// Global kill-switch for the bulk shop-level /jobs path (task #146).
// When set to "false" via env, ALL shops fall back to the legacy per-RO
// `/jobs?repairOrderId=…` shape on both the onboarding pre-warm and the
// backfill chunk pre-pass — a single env flip rolls back the entire
// feature without a code deploy if it misbehaves at scale.
//
// This guard is intentionally separate from the per-shop opt-in below.
// It exists so on-call can disable the feature globally without having
// to clear the per-shop flag on every shop.
function isBulkJobsKillSwitchOff(): boolean {
  return process.env.TEKMETRIC_BULK_JOBS_PREWARM_ENABLED === "false";
}

// Should the prewarm run via the bulk shop-level path? The prewarm only
// runs at first-time onboarding (i.e. for new shops by definition), so
// the bulk path is the default — the env kill-switch is the only thing
// that flips it off. The prewarm itself stamps
// `shops.tekmetric.bulkJobsPrewarm.enabled = true` on success so the
// backfill chunk pre-pass picks the same shop up later.
export function isBulkJobsPrewarmEnabled(): boolean {
  return !isBulkJobsKillSwitchOff();
}

// Should the backfill chunk pre-pass run via the bulk shop-level path
// for THIS shop? Default-on for newly onboarded shops only, per task
// #146 rollout: the prewarm stamps `shops.tekmetric.bulkJobsPrewarm
// .enabled = true` when it completes via the bulk path, so any shop
// onboarded after this code shipped will have it set. Shops onboarded
// BEFORE this code shipped never had a bulk prewarm and therefore have
// no flag set — those shops keep using the legacy per-RO path until
// explicitly opted in (set the field to true on the shop doc).
//
// The env kill-switch always wins when set to "false".
export function isBulkJobsPrewarmEnabledForShop(
  shop: { tekmetric?: { bulkJobsPrewarm?: { enabled?: boolean } } } | null | undefined,
): boolean {
  if (isBulkJobsKillSwitchOff()) return false;
  return shop?.tekmetric?.bulkJobsPrewarm?.enabled === true;
}

const DEFAULT_PAGE_SIZE = 100;
// Hard cap on bulk pages so a malformed `last` flag or pagination bug
// can never spin forever. 1000 pages × 100 jobs/page = 100k jobs in a
// single window — well past anything a single chunk or onboarding
// lookback realistically produces.
const DEFAULT_MAX_PAGES = 1000;

export interface BulkFetchJobsResult {
  jobsByRoId: Map<number, TekmetricJob[]>;
  pagesFetched: number;
  totalJobs: number;
  capped: boolean;
}

/**
 * Page through `/jobs?shop=X&updatedDateStart=…&updatedDateEnd=…` and
 * group the returned jobs by `repairOrderId`. Used by both the onboarding
 * pre-warm and the backfill chunk's bulk pre-pass to avoid issuing one
 * /jobs call per RO.
 *
 * Reuses the central `tekmetricRequest` plumbing transitively (via
 * `getJobsByShopWindow`), so per-shop rate-limit + 429-retry handling +
 * AsyncLocalStorage API-call counting all keep working unchanged. Do
 * not bypass this — a direct fetch would corrupt the per-chunk metrics
 * and the global limiter.
 */
export async function bulkFetchJobsByShopWindow(
  tekmetricShopId: number,
  options: {
    updatedDateStart?: string;
    updatedDateEnd?: string;
    authorizedDateStart?: string;
    authorizedDateEnd?: string;
    pageSize?: number;
    maxPages?: number;
  }
): Promise<BulkFetchJobsResult> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const jobsByRoId = new Map<number, TekmetricJob[]>();
  let pagesFetched = 0;
  let totalJobs = 0;
  let capped = false;

  for (let page = 0; page < maxPages; page++) {
    const resp = await getJobsByShopWindow(tekmetricShopId, {
      page,
      size: pageSize,
      updatedDateStart: options.updatedDateStart,
      updatedDateEnd: options.updatedDateEnd,
      authorizedDateStart: options.authorizedDateStart,
      authorizedDateEnd: options.authorizedDateEnd,
      sort: "updatedDate",
      sortDirection: "DESC",
    });
    pagesFetched++;
    const content = Array.isArray(resp?.content) ? resp.content : [];
    totalJobs += content.length;
    for (const job of content) {
      const roId = job.repairOrderId;
      // Defensive guard: the `TekmetricJob` type declares `repairOrderId`
      // as a non-null number, but the upstream API has been observed to
      // omit fields on edge-case rows. Skip silently rather than crash
      // the whole bulk pull on one malformed job.
      if (typeof roId !== "number") continue;
      const arr = jobsByRoId.get(roId);
      if (arr) arr.push(job);
      else jobsByRoId.set(roId, [job]);
    }
    if (resp?.last) break;
    if (page + 1 >= maxPages) {
      capped = true;
      break;
    }
  }

  return { jobsByRoId, pagesFetched, totalJobs, capped };
}

/**
 * Bulk upsert into `tekmetric_jobs_cache` for many ROs at once. One Mongo
 * round-trip per call instead of one per RO — the prewarm and backfill
 * pre-pass can populate hundreds of cache rows in a single write.
 *
 * Mirrors the shape that `cacheJobs` in lib/tekmetric-incremental-sync.ts
 * writes (repairOrderId, jobs[], cachedAt) so the existing `getCachedJobs`
 * read path picks up the rows transparently.
 */
export async function bulkCacheJobs(
  db: any,
  entries: Array<{ repairOrderId: number; jobs: TekmetricJob[] }>
): Promise<void> {
  if (entries.length === 0) return;
  const now = new Date();
  const ops = entries.map((e) => ({
    updateOne: {
      filter: { repairOrderId: e.repairOrderId },
      update: {
        $set: {
          repairOrderId: e.repairOrderId,
          jobs: e.jobs,
          cachedAt: now,
        },
      },
      upsert: true,
    },
  }));
  await db
    .collection("tekmetric_jobs_cache")
    .bulkWrite(ops, { ordered: false });
}
