/**
 * Tekmetric Full-Page Backfill Worker
 *
 * The regular date-window chunker (`app/api/cron/tekmetric-backfill/route.ts`)
 * walks Tekmetric's `/repair-orders` endpoint backwards in 90-day windows
 * keyed by `updatedDate`. That works for organic shops whose RO updatedDates
 * are spread across the full history range, but it FALSELY marks complete
 * for shops whose history was bulk-migrated into Tekmetric in the last few
 * weeks: every single RO has a recent `updatedDate`, so 18 windows in a row
 * return zero ROs and the chunker concludes the shop is done with only a
 * tiny fraction of its actual history indexed (Casey Palatine: 4k of 270k,
 * Casey Arlington Heights: 3.5k of 178k, Casey Streamwood: 24k of 212k).
 *
 * This module is the fix. It paginates `/repair-orders?shop=X&page=N&size=100`
 * with NO `updatedDateStart`/`updatedDateEnd` filter and `sort=id,asc` so the
 * page index is stable even as new ROs land. For each RO it builds the same
 * `job_index` document the chunker writes (so the dashboard and VHI lookups
 * see consistent data) and feeds the batch to `createIngestionService`'s
 * normalization pipeline (so `cached_plans` and other normalized collections
 * populate identically to a chunker-driven backfill).
 *
 * Resumable: per-call processes up to MAX_PAGES_PER_RUN pages then persists
 * `fullPageNextPage` on the same `tekmetric_backfill_progress` row used by
 * the chunker. The cron route invokes this until `complete:true` is returned.
 *
 * Activation: a row in `tekmetric_backfill_progress` with `fullPageMode: true`
 * is the trigger. The chunker has an early-return guard that defers to this
 * worker for any such row, so the two paths never race writes.
 */

import crypto from "crypto";
import { createIngestionService } from "@/lib/integrations/core/normalized-ingestion";
import {
  tekmetricRequest as centralTekmetricRequest,
  runWithTekmetric429Tracking,
} from "@/lib/integrations/tekmetric/client";
import {
  getCachedVehicle,
  cacheVehicle,
  getCachedCustomer,
  cacheCustomer,
  getCachedJobs,
  cacheJobs,
} from "@/lib/integrations/tekmetric/incremental-sync";
import { bumpInFlightHeartbeat } from "@/lib/integrations/tekmetric/inflight-lock";

// Each cron tick processes up to this many pages of 100 ROs each. Empirically
// each page costs ~20-30s of wall-clock at 8 RPS once vehicle/customer/jobs
// fetches are factored in (the shared Tekmetric budget gets fragmented across
// dependent calls). The SOFT_DEADLINE_MS guard below bails cleanly mid-chunk
// before Render kills the route, so a higher MAX is safe — it just lets one
// shop drain longer per tick rather than spreading thin across many shops.
// Bumped 10 -> 30 in tandem with the 5 -> 8 RPS cap bump so HEART/Honest Tom
// drains finish in weeks instead of months.
const MAX_PAGES_PER_RUN = 30;
const PAGE_SIZE = 100;
// Bail cleanly (with a progress write) before the route gets killed by
// Render's request timeout. 240s leaves ~60s headroom under the 300s limit.
const SOFT_DEADLINE_MS = 240 * 1000;

// Bulk jobs pre-pass: paginates `/jobs?shop=X` once at the start of a
// full-page backfill and writes every job to `tekmetric_jobs_prepass`
// keyed by jobId. The RO loop then looks up jobs from that collection
// instead of calling `/jobs?repairOrderId=X` once per RO. For a 270k-RO
// shop this drops the per-shop API budget from ~270k calls to ~5k calls.
//
// Idempotent: re-running the pre-pass after a crash just upserts the
// same jobs by jobId. Resumable: prePassNextPage is persisted on
// tekmetric_backfill_progress after every page.
const PREPASS_PAGE_SIZE = 100;
const PREPASS_MAX_PAGES_PER_RUN = 60; // ~6k jobs/run at 8 RPS, ~30s wall clock
const JOBS_PREPASS_COLLECTION = "tekmetric_jobs_prepass";

function isJobsPrePassEnabled(shopId: number): boolean {
  const scoped = (process.env.TEKMETRIC_FULLPAGE_BULK_PREPASS_SHOPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (scoped.length > 0) {
    return scoped.includes(String(shopId));
  }
  return process.env.TEKMETRIC_FULLPAGE_BULK_PREPASS === "true";
}

// Per-endpoint env flags so we can roll out vehicles + customers
// pre-passes independently of each other (and independently of jobs).
// The same `TEKMETRIC_FULLPAGE_BULK_PREPASS_SHOPS` allowlist applies
// to all three when set so a single shop can be opted into the full
// bulk-prepass pipeline at once.
function shopAllowlistApplies(shopId: number): { scoped: boolean; included: boolean } {
  const scoped = (process.env.TEKMETRIC_FULLPAGE_BULK_PREPASS_SHOPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (scoped.length === 0) return { scoped: false, included: false };
  return { scoped: true, included: scoped.includes(String(shopId)) };
}

function isVehiclesPrePassEnabled(shopId: number): boolean {
  const a = shopAllowlistApplies(shopId);
  if (a.scoped) return a.included;
  return process.env.TEKMETRIC_FULLPAGE_BULK_PREPASS_VEHICLES === "true";
}

function isCustomersPrePassEnabled(shopId: number): boolean {
  const a = shopAllowlistApplies(shopId);
  if (a.scoped) return a.included;
  return process.env.TEKMETRIC_FULLPAGE_BULK_PREPASS_CUSTOMERS === "true";
}

const VEHICLES_PREPASS_COLLECTION = "tekmetric_vehicles_cache";
const CUSTOMERS_PREPASS_COLLECTION = "tekmetric_customers_cache";

export interface JobsPrePassResult {
  ok: boolean;
  done: boolean;
  startPage: number;
  endPage: number;
  totalPages: number;
  pagesProcessed: number;
  jobsWritten: number;
  durationMs: number;
  error?: string;
}

/**
 * Bulk-fetch all jobs for a shop and upsert them by jobId so the RO loop
 * can read them with zero API cost. Resumable across cron ticks.
 *
 * Returns when:
 *   - all jobs pages have been walked (done=true), OR
 *   - PREPASS_MAX_PAGES_PER_RUN is hit (done=false, resume next tick), OR
 *   - the deadline is reached (done=false, resume next tick).
 */
export async function runJobsPrePass(
  db: any,
  shopId: number,
  tekmetricShopId: number,
  deadlineMs: number,
  lockOwner?: string,
): Promise<JobsPrePassResult> {
  const startedAt = Date.now();
  const progress = await db
    .collection("tekmetric_backfill_progress")
    .findOne({ shopId });
  const startPage: number =
    typeof progress?.prePassNextPage === "number"
      ? progress.prePassNextPage
      : 0;

  let page = startPage;
  let pagesProcessed = 0;
  let totalPages = 0;
  let jobsWritten = 0;
  let lastError: string | null = null;
  let reachedEnd = false;

  // Ensure indexes exist before the first write. createIndex is idempotent
  // and cheap. Without these indexes, getPrePassJobs degrades to a
  // collection scan at 270k+ docs — erasing the perf win we're chasing.
  // Compound (shopId, jobId) is the safe unique key in case Tekmetric job
  // IDs are not globally unique across shops.
  try {
    await Promise.all([
      db
        .collection(JOBS_PREPASS_COLLECTION)
        .createIndex({ shopId: 1, jobId: 1 }, { unique: true }),
      db
        .collection(JOBS_PREPASS_COLLECTION)
        .createIndex({ shopId: 1, repairOrderId: 1 }),
    ]);
  } catch (idxErr: any) {
    console.warn(
      `[Tekmetric Jobs Pre-Pass] Shop ${shopId}: index ensure failed (continuing): ${idxErr?.message || idxErr}`,
    );
  }

  console.log(
    `[Tekmetric Jobs Pre-Pass] Shop ${shopId}: starting at page ${startPage}, max ${PREPASS_MAX_PAGES_PER_RUN} pages this run`,
  );

  while (pagesProcessed < PREPASS_MAX_PAGES_PER_RUN) {
    if (Date.now() >= deadlineMs) {
      console.log(
        `[Tekmetric Jobs Pre-Pass] Shop ${shopId}: deadline reached at page ${page} (${pagesProcessed} pages this run)`,
      );
      break;
    }

    const queryParams = new URLSearchParams({
      shop: tekmetricShopId.toString(),
      page: page.toString(),
      size: PREPASS_PAGE_SIZE.toString(),
      sort: "id",
      sortDirection: "ASC",
    });

    const result = await tekmetricRequest<{
      content: TekmetricJob[];
      totalPages: number;
    }>(`/jobs?${queryParams}`, shopId);

    if (!result.ok || !result.data) {
      lastError = result.error || "Pre-pass /jobs call failed";
      console.error(
        `[Tekmetric Jobs Pre-Pass] Shop ${shopId} page ${page} error: ${lastError}`,
      );
      break;
    }

    totalPages = result.data.totalPages || 0;
    const jobs = result.data.content || [];

    if (jobs.length === 0) {
      reachedEnd = true;
      page++;
      pagesProcessed++;
      break;
    }

    // Bulk upsert keyed by compound (shopId, jobId). Idempotent — re-runs
    // overwrite the same docs. Compound key guards against the (unverified)
    // possibility that Tekmetric job IDs aren't globally unique across shops.
    try {
      const ops = jobs
        .filter((j) => typeof j?.id === "number")
        .map((job: any) => ({
          updateOne: {
            filter: { shopId, jobId: job.id },
            update: {
              $set: {
                jobId: job.id,
                shopId,
                tekmetricShopId,
                repairOrderId: job.repairOrderId,
                data: job,
                cachedAt: new Date(),
              },
            },
            upsert: true,
          },
        }));
      if (ops.length > 0) {
        await db.collection(JOBS_PREPASS_COLLECTION).bulkWrite(ops, {
          ordered: false,
        });
        jobsWritten += ops.length;
      }
    } catch (writeErr: any) {
      // Fail loudly — pre-pass without writes is just burning API quota.
      lastError = `pre-pass bulkWrite failed: ${writeErr?.message || writeErr}`;
      console.error(
        `[Tekmetric Jobs Pre-Pass] Shop ${shopId} page ${page} write error: ${lastError}`,
      );
      break;
    }

    page++;
    pagesProcessed++;

    // Persist after every page so a mid-run timeout costs only one page.
    // Only persist `prePassTotalPages` when the API reported a real value;
    // otherwise leave the existing field alone so we don't overwrite a
    // healthy snapshot with 0 (the same corruption pattern as full-page).
    const prePassPageUpdate: any = {
      prePassNextPage: page,
      lastPrePassRunAt: new Date(),
    };
    if (totalPages > 0) prePassPageUpdate.prePassTotalPages = totalPages;
    await db
      .collection("tekmetric_backfill_progress")
      .updateOne({ shopId }, { $set: prePassPageUpdate })
      .catch(() => {});

    // Heartbeat: signal the in-flight lock that we're making real
    // progress so the next acquire attempt doesn't (rightfully) steal
    // the lock under us as stale. See `bumpInFlightHeartbeat` for why
    // this is owner-scoped.
    if (lockOwner) {
      await bumpInFlightHeartbeat(db, shopId, lockOwner);
    }

    if (totalPages > 0 && page >= totalPages) {
      reachedEnd = true;
      break;
    }
  }

  const done = reachedEnd && !lastError;
  if (done) {
    const doneUpdate: any = {
      prePassDone: true,
      prePassCompletedAt: new Date(),
      prePassNextPage: page,
    };
    if (totalPages > 0) doneUpdate.prePassTotalPages = totalPages;
    await db
      .collection("tekmetric_backfill_progress")
      .updateOne({ shopId }, { $set: doneUpdate })
      .catch(() => {});
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[Tekmetric Jobs Pre-Pass] Shop ${shopId}: pages ${startPage}..${page - 1} of ${totalPages || "?"}, ${jobsWritten} jobs written, ${durationMs}ms${done ? " — DONE" : ""}`,
  );

  return {
    ok: !lastError,
    done,
    startPage,
    endPage: page - 1,
    totalPages,
    pagesProcessed,
    jobsWritten,
    durationMs,
    error: lastError || undefined,
  };
}

/**
 * Look up jobs for an RO from the pre-pass index.
 *
 * Returns:
 *   - TekmetricJob[] (possibly empty) on a successful query.
 *   - null ONLY on a query error — caller MUST treat null as "unknown,
 *     fall back to the API" rather than "no jobs", otherwise a transient
 *     Mongo blip silently drops jobs from the backfill.
 *
 * The empty-vs-null distinction is load-bearing: with prePassDoneForShop=true,
 * an empty result legitimately means the RO has no jobs (skip safely),
 * but a null result means we couldn't read the index and must fall back.
 */
async function getPrePassJobs(
  db: any,
  shopId: number,
  repairOrderId: number,
): Promise<TekmetricJob[] | null> {
  try {
    const docs = await db
      .collection(JOBS_PREPASS_COLLECTION)
      .find({ shopId, repairOrderId })
      .project({ data: 1, _id: 0 })
      .toArray();
    return (docs || []).map((d: any) => d.data as TekmetricJob);
  } catch (err: any) {
    console.warn(
      `[Tekmetric Jobs Pre-Pass] getPrePassJobs error for shop ${shopId} RO ${repairOrderId}: ${err?.message || err}`,
    );
    return null;
  }
}

export interface EntityPrePassResult {
  ok: boolean;
  done: boolean;
  startPage: number;
  endPage: number;
  totalPages: number;
  pagesProcessed: number;
  itemsWritten: number;
  durationMs: number;
  error?: string;
}

/**
 * Generic bulk-prepass for a shop-paginated Tekmetric list endpoint
 * (currently `/vehicles` and `/customers`). Walks the endpoint with
 * `?shop=X&page=N&size=100&sort=id&sortDirection=ASC` and upserts each
 * item by `(shopId, <idField>)` into `collectionName`. Resumable across
 * cron ticks via `nextPageField` / `donePageField` on the
 * `tekmetric_backfill_progress` row.
 *
 * Modeled after `runJobsPrePass`. Same idempotency, same per-page
 * progress write, same deadline-aware bail. Kept generic because the
 * vehicle and customer paths only differ in the endpoint path, the
 * collection name, and the progress doc field names — duplicating the
 * 130+ lines of bookkeeping for each would be pure noise.
 */
async function runEntityPrePass(opts: {
  db: any;
  shopId: number;
  tekmetricShopId: number;
  deadlineMs: number;
  endpoint: "vehicles" | "customers";
  collectionName: string;
  idField: "vehicleId" | "customerId";
  nextPageField: string;
  donePageField: string;
  totalPagesField: string;
  completedAtField: string;
  lastRunAtField: string;
  logTag: string;
  lockOwner?: string;
}): Promise<EntityPrePassResult> {
  const {
    db,
    shopId,
    tekmetricShopId,
    deadlineMs,
    endpoint,
    collectionName,
    idField,
    nextPageField,
    donePageField,
    totalPagesField,
    completedAtField,
    lastRunAtField,
    logTag,
    lockOwner,
  } = opts;
  const startedAt = Date.now();
  const progress = await db
    .collection("tekmetric_backfill_progress")
    .findOne({ shopId });
  const startPage: number =
    typeof progress?.[nextPageField] === "number"
      ? progress[nextPageField]
      : 0;

  let page = startPage;
  let pagesProcessed = 0;
  let totalPages = 0;
  let itemsWritten = 0;
  let lastError: string | null = null;
  let reachedEnd = false;

  // Same compound index as the jobs prepass: scoped by (shopId, id) so
  // lookups don't degrade to a collection scan, and unique so re-runs
  // upsert deterministically.
  try {
    await db
      .collection(collectionName)
      .createIndex({ shopId: 1, [idField]: 1 }, { unique: true });
  } catch (idxErr: any) {
    console.warn(
      `${logTag} Shop ${shopId}: index ensure failed (continuing): ${idxErr?.message || idxErr}`,
    );
  }

  console.log(
    `${logTag} Shop ${shopId}: starting at page ${startPage}, max ${PREPASS_MAX_PAGES_PER_RUN} pages this run`,
  );

  while (pagesProcessed < PREPASS_MAX_PAGES_PER_RUN) {
    if (Date.now() >= deadlineMs) {
      console.log(
        `${logTag} Shop ${shopId}: deadline reached at page ${page} (${pagesProcessed} pages this run)`,
      );
      break;
    }

    const queryParams = new URLSearchParams({
      shop: tekmetricShopId.toString(),
      page: page.toString(),
      size: PREPASS_PAGE_SIZE.toString(),
      sort: "id",
      sortDirection: "ASC",
    });

    const result = await tekmetricRequest<{
      content: Array<{ id: number }>;
      totalPages: number;
    }>(`/${endpoint}?${queryParams}`, shopId);

    if (!result.ok || !result.data) {
      lastError = result.error || `Pre-pass /${endpoint} call failed`;
      console.error(
        `${logTag} Shop ${shopId} page ${page} error: ${lastError}`,
      );
      break;
    }

    totalPages = result.data.totalPages || 0;
    const items = result.data.content || [];

    if (items.length === 0) {
      reachedEnd = true;
      page++;
      pagesProcessed++;
      break;
    }

    try {
      const ops = items
        .filter((it) => typeof it?.id === "number")
        .map((it: any) => ({
          updateOne: {
            filter: { shopId, [idField]: it.id },
            update: {
              $set: {
                [idField]: it.id,
                shopId,
                tekmetricShopId,
                data: it,
                cachedAt: new Date(),
              },
            },
            upsert: true,
          },
        }));
      if (ops.length > 0) {
        await db
          .collection(collectionName)
          .bulkWrite(ops, { ordered: false });
        itemsWritten += ops.length;
      }
    } catch (writeErr: any) {
      lastError = `pre-pass bulkWrite failed: ${writeErr?.message || writeErr}`;
      console.error(
        `${logTag} Shop ${shopId} page ${page} write error: ${lastError}`,
      );
      break;
    }

    page++;
    pagesProcessed++;

    // See runJobsPrePass: guard totalPages=0 so a stale-API response
    // doesn't corrupt the persisted totalPages field.
    const entityPageUpdate: any = {
      [nextPageField]: page,
      [lastRunAtField]: new Date(),
    };
    if (totalPages > 0) entityPageUpdate[totalPagesField] = totalPages;
    await db
      .collection("tekmetric_backfill_progress")
      .updateOne({ shopId }, { $set: entityPageUpdate })
      .catch(() => {});

    if (lockOwner) {
      await bumpInFlightHeartbeat(db, shopId, lockOwner);
    }

    if (totalPages > 0 && page >= totalPages) {
      reachedEnd = true;
      break;
    }
  }

  const done = reachedEnd && !lastError;
  if (done) {
    const entityDoneUpdate: any = {
      [donePageField]: true,
      [completedAtField]: new Date(),
      [nextPageField]: page,
    };
    if (totalPages > 0) entityDoneUpdate[totalPagesField] = totalPages;
    await db
      .collection("tekmetric_backfill_progress")
      .updateOne({ shopId }, { $set: entityDoneUpdate })
      .catch(() => {});
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `${logTag} Shop ${shopId}: pages ${startPage}..${page - 1} of ${totalPages || "?"}, ${itemsWritten} ${endpoint} written, ${durationMs}ms${done ? " — DONE" : ""}`,
  );

  return {
    ok: !lastError,
    done,
    startPage,
    endPage: page - 1,
    totalPages,
    pagesProcessed,
    itemsWritten,
    durationMs,
    error: lastError || undefined,
  };
}

export async function runVehiclesPrePass(
  db: any,
  shopId: number,
  tekmetricShopId: number,
  deadlineMs: number,
  lockOwner?: string,
): Promise<EntityPrePassResult> {
  return runEntityPrePass({
    db,
    shopId,
    tekmetricShopId,
    deadlineMs,
    endpoint: "vehicles",
    collectionName: VEHICLES_PREPASS_COLLECTION,
    idField: "vehicleId",
    nextPageField: "vehiclesPrePassNextPage",
    donePageField: "vehiclesPrePassDone",
    totalPagesField: "vehiclesPrePassTotalPages",
    completedAtField: "vehiclesPrePassCompletedAt",
    lastRunAtField: "lastVehiclesPrePassRunAt",
    logTag: "[Tekmetric Vehicles Pre-Pass]",
    lockOwner,
  });
}

export async function runCustomersPrePass(
  db: any,
  shopId: number,
  tekmetricShopId: number,
  deadlineMs: number,
  lockOwner?: string,
): Promise<EntityPrePassResult> {
  return runEntityPrePass({
    db,
    shopId,
    tekmetricShopId,
    deadlineMs,
    endpoint: "customers",
    collectionName: CUSTOMERS_PREPASS_COLLECTION,
    idField: "customerId",
    nextPageField: "customersPrePassNextPage",
    donePageField: "customersPrePassDone",
    totalPagesField: "customersPrePassTotalPages",
    completedAtField: "customersPrePassCompletedAt",
    lastRunAtField: "lastCustomersPrePassRunAt",
    logTag: "[Tekmetric Customers Pre-Pass]",
    lockOwner,
  });
}

/**
 * Look up a single vehicle from the bulk pre-pass cache.
 *
 * Same null-vs-undefined semantics as `getPrePassJobs`:
 *   - Returns `undefined` on a query error so caller treats it as
 *     "unknown, fall back to per-RO API".
 *   - Returns `null` when the query succeeded but no doc exists for
 *     that vehicle. Caller MUST decide whether the missing doc means
 *     "vehicle was created after pre-pass walked, fall back to API"
 *     or "this shop's pre-pass legitimately has no row" — typically
 *     it's the former, since pre-passes only exist for shops that
 *     opted in.
 */
export async function getPrePassVehicle(
  db: any,
  shopId: number,
  vehicleId: number,
): Promise<any | null | undefined> {
  try {
    const doc = await db
      .collection(VEHICLES_PREPASS_COLLECTION)
      .findOne({ shopId, vehicleId }, { projection: { data: 1, _id: 0 } });
    return doc ? (doc.data as any) : null;
  } catch (err: any) {
    console.warn(
      `[Tekmetric Vehicles Pre-Pass] getPrePassVehicle error for shop ${shopId} vehicle ${vehicleId}: ${err?.message || err}`,
    );
    return undefined;
  }
}

/** See `getPrePassVehicle` for null/undefined semantics. */
export async function getPrePassCustomer(
  db: any,
  shopId: number,
  customerId: number,
): Promise<any | null | undefined> {
  try {
    const doc = await db
      .collection(CUSTOMERS_PREPASS_COLLECTION)
      .findOne({ shopId, customerId }, { projection: { data: 1, _id: 0 } });
    return doc ? (doc.data as any) : null;
  } catch (err: any) {
    console.warn(
      `[Tekmetric Customers Pre-Pass] getPrePassCustomer error for shop ${shopId} customer ${customerId}: ${err?.message || err}`,
    );
    return undefined;
  }
}

type TekmetricVehicle = {
  id: number;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  engine?: string;
  mileageIn?: number;
  mileageOut?: number;
};

type TekmetricCustomer = {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
};

type TekmetricJob = {
  id: number;
  repairOrderId: number;
  name: string;
  laborTotal?: number;
  partsTotal?: number;
  subtotal?: number;
  laborHours?: number;
  labor?: any[];
  parts?: Array<{
    id: number;
    partNumber?: string;
    name?: string;
    description?: string;
    quantity?: number;
    cost?: number;
    retailCost?: number;
    brand?: string;
  }>;
  createdDate?: string;
  updatedDate?: string;
};

type TekmetricRepairOrder = {
  id: number;
  repairOrderNumber: number;
  shopId: number;
  customerId?: number;
  vehicleId?: number;
  repairOrderStatus?: { id: number; code: string; name: string };
  milesIn?: number;
  milesOut?: number;
  postedDate?: string;
  completedDate?: string;
  createdDate?: string;
  updatedDate?: string;
};

async function tekmetricRequest<T>(
  endpoint: string,
  shopId?: number,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    // Backfill is background work — yield rate-limit slots to interactive
    // VHI/dashboard requests so techs aren't waiting behind a 30-page chunk.
    const data = await centralTekmetricRequest<T>(
      endpoint,
      {},
      shopId,
      false,
      false,
      'background',
    );
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

function computeContentHash(entry: any): string {
  const hashContent = {
    workOrderId: entry.workOrderId,
    servicePackageId: entry.servicePackageId,
    vehicle: entry.vehicle,
    jobName: entry.jobName,
    lines: entry.lines,
    totalAmount: entry.totalAmount,
    laborAmount: entry.laborAmount,
    partsAmount: entry.partsAmount,
    laborHours: entry.laborHours,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(hashContent))
    .digest("hex")
    .slice(0, 16);
}

export interface FullPageBackfillResult {
  ok: boolean;
  complete: boolean;
  pagesProcessed: number;
  startPage: number;
  endPage: number;
  totalPages: number;
  rosFetched: number;
  jobsIndexed: number;
  jobsSkipped: number;
  normalizedCount: number;
  message: string;
  error?: string;
}

/**
 * Run a single full-page backfill chunk for one shop.
 *
 * Returns when MAX_PAGES_PER_RUN pages are processed OR Tekmetric reports
 * `page+1 >= totalPages` (the latter sets `complete:true` and clears the
 * fullPageMode flag so this shop drops out of the worker queue).
 */
export async function runFullPageBackfillChunk(
  db: any,
  shopId: number,
  tekmetricShopId: number,
  lockOwner?: string,
  // Absolute wall-clock deadline (ms) from the calling cron/route. The chunk
  // stops adding work by min(its own soft deadline, this) so the route can
  // return before its hard 300s kill — a chunk started late in a tick no
  // longer overruns and times out the whole request.
  routeDeadlineMs?: number,
): Promise<FullPageBackfillResult> {
  // Task #460: capture write fan-out + record into backfill_chunk_metrics.
  const { withChunkWriteCounters } = await import("@/lib/backfill-metrics/write-counters");
  const { recordChunkMetric } = await import("@/lib/backfill-metrics/chunk-metrics");
  return withChunkWriteCounters(async (chunkWriteCounters) => {
  const _metricStartedAt = Date.now();
  let _metricOutcome: "ok" | "error" | "deferred" | "complete" | "empty" = "ok";
  let _metricRos = 0;
  try {
  const _result = await runWithTekmetric429Tracking(async () => {
    const startedAt = Date.now();
    // Honour the caller's route deadline if it's tighter than our own soft
    // budget, so a chunk started late in a cron tick stops in time instead of
    // overrunning the route's hard kill.
    const softDeadlineMs = routeDeadlineMs
      ? Math.min(startedAt + SOFT_DEADLINE_MS, routeDeadlineMs)
      : startedAt + SOFT_DEADLINE_MS;
    const progress = await db
      .collection("tekmetric_backfill_progress")
      .findOne({ shopId });
    const startPage: number =
      typeof progress?.fullPageNextPage === "number"
        ? progress.fullPageNextPage
        : 0;

    const shop = await db.collection("shops").findOne({ shopId });
    const enterpriseId = shop?.enterpriseId;
    const ingestionService = createIngestionService(
      db,
      "tekmetric",
      shopId,
      enterpriseId,
      {
        syncRunId: `tekmetric-fullpage-${Date.now()}`,
        createAuditLog: false,
        dualWriteToJobIndex: true,
        dualWriteToRepairPatterns: true,
      },
    );

    let page = startPage;
    let pagesProcessed = 0;
    let totalPages = 0;
    let rosFetched = 0;
    let jobsIndexed = 0;
    let jobsSkipped = 0;
    const rosForNormalized: any[] = [];

    // Per-run caches: vehicles and customers are looked up many times across
    // the same shop. Mongo cache (getCachedVehicle/getCachedCustomer) is the
    // cross-run fallback; this in-memory map saves the Mongo roundtrip
    // within a single run.
    const vehicleCache = new Map<number, TekmetricVehicle>();
    const customerCache = new Map<number, TekmetricCustomer>();

    // Bulk jobs pre-pass: if enabled for this shop and not yet complete,
    // burn this tick's budget on the pre-pass. The next tick will see
    // prePassDone=true and proceed to the RO loop with zero per-RO /jobs
    // API calls.
    const prePassEnabled = isJobsPrePassEnabled(shopId);
    let prePassDoneForShop = !!progress?.prePassDone;
    const vehiclesPrePassEnabled = isVehiclesPrePassEnabled(shopId);
    let vehiclesPrePassDoneForShop = !!progress?.vehiclesPrePassDone;
    const customersPrePassEnabled = isCustomersPrePassEnabled(shopId);
    let customersPrePassDoneForShop = !!progress?.customersPrePassDone;
    const tickDeadlineMs = softDeadlineMs;
    if (prePassEnabled && !prePassDoneForShop) {
      const prePassResult = await runJobsPrePass(
        db,
        shopId,
        tekmetricShopId,
        tickDeadlineMs,
        lockOwner,
      );
      prePassDoneForShop = prePassResult.done;
      if (!prePassResult.done) {
        // Hand the rest of this tick back to the cron — pre-pass needs more.
        return {
          ok: prePassResult.ok,
          complete: false,
          pagesProcessed: 0,
          startPage,
          endPage: startPage - 1,
          totalPages: 0,
          rosFetched: 0,
          jobsIndexed: 0,
          jobsSkipped: 0,
          normalizedCount: 0,
          message: `pre-pass in progress: page ${prePassResult.endPage + 1} of ${prePassResult.totalPages || "?"}, ${prePassResult.jobsWritten} jobs written this tick`,
          error: prePassResult.error,
        };
      }
    }

    // Bulk vehicles pre-pass — same shape as the jobs pre-pass above.
    // Independently gated so we can roll out per-endpoint. The per-RO
    // /vehicles/{id} fan-out is the dominant remaining bottleneck on
    // first-time backfills (50-60% miss rate against the legacy 24h
    // TTL'd `tekmetric_vehicle_cache`); walking `/vehicles?shop=X` once
    // drops the per-RO API budget for vehicles to ~0 for the rest of
    // the backfill.
    if (vehiclesPrePassEnabled && !vehiclesPrePassDoneForShop) {
      const vRes = await runVehiclesPrePass(
        db,
        shopId,
        tekmetricShopId,
        tickDeadlineMs,
        lockOwner,
      );
      vehiclesPrePassDoneForShop = vRes.done;
      if (!vRes.done) {
        return {
          ok: vRes.ok,
          complete: false,
          pagesProcessed: 0,
          startPage,
          endPage: startPage - 1,
          totalPages: 0,
          rosFetched: 0,
          jobsIndexed: 0,
          jobsSkipped: 0,
          normalizedCount: 0,
          message: `vehicles pre-pass in progress: page ${vRes.endPage + 1} of ${vRes.totalPages || "?"}, ${vRes.itemsWritten} vehicles written this tick`,
          error: vRes.error,
        };
      }
    }

    if (customersPrePassEnabled && !customersPrePassDoneForShop) {
      const cRes = await runCustomersPrePass(
        db,
        shopId,
        tekmetricShopId,
        tickDeadlineMs,
        lockOwner,
      );
      customersPrePassDoneForShop = cRes.done;
      if (!cRes.done) {
        return {
          ok: cRes.ok,
          complete: false,
          pagesProcessed: 0,
          startPage,
          endPage: startPage - 1,
          totalPages: 0,
          rosFetched: 0,
          jobsIndexed: 0,
          jobsSkipped: 0,
          normalizedCount: 0,
          message: `customers pre-pass in progress: page ${cRes.endPage + 1} of ${cRes.totalPages || "?"}, ${cRes.itemsWritten} customers written this tick`,
          error: cRes.error,
        };
      }
    }

    let vehiclesCacheHits = 0;
    let vehiclesCacheMisses = 0;
    let customersCacheHits = 0;
    let customersCacheMisses = 0;

    console.log(
      `[Tekmetric Full-Page Backfill] Shop ${shopId}: starting at page ${startPage}, max ${MAX_PAGES_PER_RUN} pages this run${prePassDoneForShop ? " (jobs pre-pass in use)" : ""}${vehiclesPrePassDoneForShop ? " (vehicles pre-pass in use)" : ""}${customersPrePassDoneForShop ? " (customers pre-pass in use)" : ""}`,
    );

    let lastError: string | null = null;
    let reachedEnd = false;

    while (pagesProcessed < MAX_PAGES_PER_RUN) {
      // Pre-fetch guard: if we've already hit the soft deadline, stop before
      // issuing another page fetch so a chunk started late in the cron tick
      // can't overrun the route's hard kill with one more full page cycle.
      if (Date.now() >= softDeadlineMs) {
        console.log(
          `[Tekmetric Full-Page Backfill] Shop ${shopId}: soft deadline reached before page ${page}, deferring rest to next tick`,
        );
        break;
      }

      const queryParams = new URLSearchParams({
        shop: tekmetricShopId.toString(),
        page: page.toString(),
        size: PAGE_SIZE.toString(),
        sort: "id",
        sortDirection: "ASC",
      });

      const rosResult = await tekmetricRequest<{
        content: TekmetricRepairOrder[];
        totalPages: number;
        totalElements?: number;
      }>(`/repair-orders?${queryParams}`, shopId);

      if (!rosResult.ok || !rosResult.data) {
        lastError = rosResult.error || "RO list call failed";
        console.error(
          `[Tekmetric Full-Page Backfill] Shop ${shopId} page ${page} error: ${lastError}`,
        );
        break;
      }

      totalPages = rosResult.data.totalPages || 0;
      const ros = rosResult.data.content || [];

      console.log(
        `[Tekmetric Full-Page Backfill] Shop ${shopId} page ${page + 1}/${totalPages}: ${ros.length} ROs`,
      );

      if (ros.length === 0) {
        // Sorted-ASC pagination past the last page. Done.
        reachedEnd = true;
        page++;
        pagesProcessed++;
        break;
      }

      rosFetched += ros.length;

      for (const ro of ros) {
        try {
          const statusCode =
            ro.repairOrderStatus?.code?.toUpperCase() || "";
          // Match the chunker's filter: only terminal ROs get indexed. Open
          // ROs change too often to be useful for service-history lookups.
          if (
            !["POSTED", "INVOICED", "COMPLETED"].includes(statusCode)
          ) {
            continue;
          }

          let vehicle: TekmetricVehicle | null = null;
          if (ro.vehicleId) {
            if (vehicleCache.has(ro.vehicleId)) {
              vehicle = vehicleCache.get(ro.vehicleId)!;
              vehiclesCacheHits++;
            } else {
              // Lookup chain:
              //   1. Bulk pre-pass cache (`tekmetric_vehicles_cache`,
              //      populated by runVehiclesPrePass) — zero API cost.
              //   2. Legacy 24h TTL'd `tekmetric_vehicle_cache`.
              //   3. Per-RO `/vehicles/{id}` API call.
              let prePassVehicle: any = undefined;
              if (vehiclesPrePassDoneForShop) {
                prePassVehicle = await getPrePassVehicle(
                  db,
                  shopId,
                  ro.vehicleId,
                );
              }
              if (prePassVehicle) {
                vehicle = prePassVehicle as TekmetricVehicle;
                vehicleCache.set(ro.vehicleId, vehicle);
                vehiclesCacheHits++;
              } else {
                const cached = await getCachedVehicle(
                  db,
                  ro.vehicleId,
                ).catch(() => null);
                if (cached) {
                  vehicle = cached as TekmetricVehicle;
                  vehicleCache.set(ro.vehicleId, vehicle);
                  vehiclesCacheHits++;
                } else {
                  vehiclesCacheMisses++;
                  const vehResult = await tekmetricRequest<TekmetricVehicle>(
                    `/vehicles/${ro.vehicleId}`,
                    shopId,
                  );
                  if (vehResult.ok && vehResult.data) {
                    vehicle = vehResult.data;
                    vehicleCache.set(ro.vehicleId, vehicle);
                    await cacheVehicle(db, ro.vehicleId, vehResult.data as any).catch(
                      () => {},
                    );
                  }
                }
              }
            }
          }

          let customer: TekmetricCustomer | null = null;
          if (ro.customerId) {
            if (customerCache.has(ro.customerId)) {
              customer = customerCache.get(ro.customerId)!;
              customersCacheHits++;
            } else {
              let prePassCustomer: any = undefined;
              if (customersPrePassDoneForShop) {
                prePassCustomer = await getPrePassCustomer(
                  db,
                  shopId,
                  ro.customerId,
                );
              }
              if (prePassCustomer) {
                customer = prePassCustomer as TekmetricCustomer;
                customerCache.set(ro.customerId, customer);
                customersCacheHits++;
              } else {
                const cached = await getCachedCustomer(
                  db,
                  ro.customerId,
                ).catch(() => null);
                if (cached) {
                  customer = cached as TekmetricCustomer;
                  customerCache.set(ro.customerId, customer);
                  customersCacheHits++;
                } else {
                  customersCacheMisses++;
                  const custResult =
                    await tekmetricRequest<TekmetricCustomer>(
                      `/customers/${ro.customerId}`,
                      shopId,
                    );
                  if (custResult.ok && custResult.data) {
                    customer = custResult.data;
                    customerCache.set(ro.customerId, customer);
                    await cacheCustomer(
                      db,
                      ro.customerId,
                      custResult.data as any,
                    ).catch(() => {});
                  }
                }
              }
            }
          }

          // Jobs lookup priority:
          //   1. Bulk pre-pass index (`tekmetric_jobs_prepass`, populated
          //      once per shop by runJobsPrePass) — zero API cost.
          //   2. Per-RO TTL'd Mongo cache (`tekmetric_jobs_cache`).
          //   3. Webhook-cached `tekmetric_work_orders.data.jobs`.
          //   4. Fallback: per-RO `/jobs?repairOrderId=X` API call.
          // When the pre-pass is done for this shop, an empty result from
          // step 1 means the RO genuinely has no jobs and we skip without
          // burning an API call.
          let jobs: TekmetricJob[] = [];
          let prePassUsed = false;
          if (prePassDoneForShop) {
            const prepassJobs = await getPrePassJobs(db, shopId, ro.id);
            // Safety net: if the RO was created/updated AFTER the pre-pass
            // finished walking, the index can't possibly know about its
            // jobs. Fall through to the cache/API chain so we don't drop
            // newly-created ROs.
            const prePassCompletedAt = progress?.prePassCompletedAt
              ? new Date(progress.prePassCompletedAt).getTime()
              : 0;
            const roTouchedAt = (() => {
              const u = (ro as any).updatedDate || (ro as any).createdDate;
              return u ? new Date(u).getTime() : 0;
            })();
            const newerThanPrePass =
              prePassCompletedAt > 0 && roTouchedAt > prePassCompletedAt;

            if (prepassJobs === null) {
              // Query error — treat as unknown, fall through to cache/API.
              // (Do NOT skip the RO; that would silently drop jobs on a
              // transient Mongo blip.)
            } else if (newerThanPrePass) {
              // RO post-dates the pre-pass; index may be stale for it.
              // Fall through to cache/API for a fresh read.
            } else if (prepassJobs.length > 0) {
              jobs = prepassJobs;
              prePassUsed = true;
            } else {
              // Successful query, zero docs, RO not newer than pre-pass:
              // pre-pass walked every job for this shop and this RO had
              // none. Skip without a per-RO API call.
              continue;
            }
          }
          const cachedJobs = prePassUsed
            ? null
            : await getCachedJobs(db, ro.id).catch(() => null);
          if (!prePassUsed && cachedJobs) {
            jobs = cachedJobs as TekmetricJob[];
          } else if (!prePassUsed) {
            const cachedWO = await db
              .collection("tekmetric_work_orders")
              .findOne(
                {
                  shopId: { $in: [String(shopId), Number(shopId)] },
                  workOrderId: String(ro.id),
                },
                { projection: { "data.jobs": 1 } },
              )
              .catch(() => null);
            const woJobs = cachedWO?.data?.jobs;
            if (Array.isArray(woJobs) && woJobs.length > 0) {
              jobs = woJobs as TekmetricJob[];
              await cacheJobs(db, ro.id, jobs).catch(() => {});
            } else {
              const jobsResult = await tekmetricRequest<{
                content: TekmetricJob[];
              }>(
                `/jobs?shop=${tekmetricShopId}&repairOrderId=${ro.id}`,
                shopId,
              );
              if (!jobsResult.ok) {
                console.warn(
                  `[Tekmetric Full-Page Backfill] Shop ${shopId} RO ${ro.id} /jobs failed: ${jobsResult.error}`,
                );
                continue;
              }
              jobs = jobsResult.data?.content || [];
              await cacheJobs(db, ro.id, jobs).catch(() => {});
            }
          }

          if (jobs.length === 0) continue;

          // Task #484: snapshot the indexed counter so we can decide at the
          // end of this RO whether the broadcast should fire. The whole point
          // of the per-RO broadcast is to nudge the overlay when content
          // ACTUALLY changed — firing on every RO would inflate
          // /api/extension/plan volume and defeat the goal.
          const jobsIndexedBeforeRo = jobsIndexed;

          for (const job of jobs) {
            const laborAmountDollars = (job.laborTotal || 0) / 100;
            const partsAmountDollars = (job.partsTotal || 0) / 100;

            const roMileage =
              (typeof ro.milesOut === "number" && ro.milesOut > 0
                ? ro.milesOut
                : null) ??
              (typeof ro.milesIn === "number" && ro.milesIn > 0
                ? ro.milesIn
                : null) ??
              (vehicle &&
              typeof (vehicle as any).mileageOut === "number" &&
              (vehicle as any).mileageOut > 0
                ? (vehicle as any).mileageOut
                : null) ??
              (vehicle &&
              typeof (vehicle as any).mileageIn === "number" &&
              (vehicle as any).mileageIn > 0
                ? (vehicle as any).mileageIn
                : null) ??
              null;

            const entry: any = {
              shopId,
              sourceSystem: "tekmetric",
              workOrderId: String(ro.id),
              workOrderNumber: ro.repairOrderNumber,
              servicePackageId: String(job.id),
              jobName: job.name,
              closedAt:
                ro.postedDate || ro.completedDate || ro.updatedDate,
              mileage: roMileage,
              vehicle: vehicle
                ? {
                    vin: vehicle.vin,
                    year: vehicle.year,
                    make: vehicle.make,
                    model: vehicle.model,
                    engine: vehicle.engine,
                    mileage: roMileage,
                  }
                : null,
              customer: customer
                ? {
                    name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim(),
                    email: customer.email,
                    phone: customer.phone,
                  }
                : null,
              totalAmount: (job.subtotal || 0) / 100,
              laborAmount: laborAmountDollars,
              partsAmount: partsAmountDollars,
              laborHours: job.laborHours || 0,
              lines: [] as any[],
              indexedAt: new Date(),
            };

            if (job.parts?.length) {
              for (const part of job.parts) {
                entry.lines.push({
                  lineType: "part",
                  partNumber: part.partNumber,
                  description: part.name,
                  manufacturer: part.brand,
                  quantity: part.quantity || 1,
                  unitPrice: (part.retailCost || 0) / 100,
                  extendedPrice:
                    ((part.quantity || 1) * (part.retailCost || 0)) / 100,
                });
              }
            }

            const contentHash = computeContentHash(entry);
            const filter = {
              shopId,
              workOrderId: String(ro.id),
              servicePackageId: String(job.id),
            };
            const existing = await db
              .collection("job_index")
              .findOne(filter);
            if (existing && existing.contentHash === contentHash) {
              jobsSkipped++;
              continue;
            }
            await db
              .collection("job_index")
              .updateOne(
                filter,
                { $set: { ...entry, contentHash } },
                { upsert: true },
              );
            jobsIndexed++;
          }

          // Task #484: nudge the Detect Dog overlay so a tech viewing this
          // VIN sees fresh VHI within a second of the backfill landing a
          // change. Fire only when at least one job ACTUALLY changed for
          // this RO (jobsIndexed delta > 0) — content-hash matches that
          // bump `jobsSkipped++` instead must not trigger a refresh — and
          // only when we know the VIN. Fire-and-forget; the broadcaster
          // also debounces per (shop,vin) as a second safety net.
          if (jobsIndexed > jobsIndexedBeforeRo && vehicle?.vin) {
            try {
              const { broadcastVhiUpdated } = await import(
                "@/lib/realtime/broadcast-vhi"
              );
              broadcastVhiUpdated({
                vin: String(vehicle.vin),
                shopId,
                reason: "fullpage_backfill",
              }).catch(() => {});
            } catch {
              // module load failed — non-fatal
            }
          }

          rosForNormalized.push({
            id: ro.id,
            repairOrderNumber: ro.repairOrderNumber,
            repairOrderStatus:
              ro.repairOrderStatus?.code || ro.repairOrderStatus,
            postedDate: ro.postedDate,
            completedDate: ro.completedDate,
            createdDate: ro.createdDate,
            updatedDate: ro.updatedDate,
            milesIn: ro.milesIn,
            milesOut: ro.milesOut,
            laborSubtotal: jobs.reduce(
              (sum, j) => sum + (j.laborTotal || 0),
              0,
            ),
            partsSubtotal: jobs.reduce(
              (sum, j) => sum + (j.partsTotal || 0),
              0,
            ),
            total: jobs.reduce((sum, j) => sum + (j.subtotal || 0), 0),
            vehicle: vehicle,
            customer: customer,
            jobs: jobs.map((j) => ({
              id: j.id,
              name: j.name,
              laborTotal: (j.laborTotal || 0) / 100,
              partsTotal: (j.partsTotal || 0) / 100,
              total: (j.subtotal || 0) / 100,
              laborHours: j.laborHours || 0,
              labor: j.labor,
              parts: j.parts,
            })),
            inspections: [],
            inspectionUrl: (ro as any).inspectionUrl || null,
            inspectionShareDate:
              (ro as any).inspectionShareDate || null,
            rawPayload: {
              repairOrder: ro,
              vehicle,
              customer,
              jobs,
            },
          });
        } catch (roErr: any) {
          // Per-RO safety net mirrors the chunker: never let one bad RO
          // crash the whole page.
          console.warn(
            `[Tekmetric Full-Page Backfill] Shop ${shopId} RO ${ro.id} threw: ${(roErr?.message || String(roErr)).slice(0, 200)}`,
          );
        }
      }

      page++;
      pagesProcessed++;

      // Persist progress after EVERY page so a mid-chunk timeout only costs
      // one page of work. Without this, a request killed by Render's 300s
      // limit (or the cron wrapper's 5min timeout) loses the whole batch
      // and the next tick restarts from `fullPageNextPage`'s last value —
      // which, on a fresh flag, is still 0. That's how shop 82 spent 30
      // minutes re-indexing the same first 7 pages.
      try {
        // Guard totalPages=0: a stale or anomalous API response with
        // totalPages=0 must NOT overwrite a previously-known good value
        // (this is what stuck shops 112/123 — task #443 / #448).
        const fullPagePageUpdate: any = {
          fullPageNextPage: page,
          lastFullPageRunAt: new Date(),
        };
        if (totalPages > 0) fullPagePageUpdate.fullPageTotalPages = totalPages;
        await db
          .collection("tekmetric_backfill_progress")
          .updateOne({ shopId }, { $set: fullPagePageUpdate });
      } catch (writeErr: any) {
        console.warn(
          `[Tekmetric Full-Page Backfill] Shop ${shopId} progress write failed at page ${page}: ${writeErr?.message || writeErr}`,
        );
      }

      // Heartbeat: real page progress, signal the in-flight lock.
      if (lockOwner) {
        await bumpInFlightHeartbeat(db, shopId, lockOwner);
      }

      if (totalPages > 0 && page >= totalPages) {
        reachedEnd = true;
        break;
      }

      // Soft deadline: stop adding pages so we have time to flush the
      // normalized batch + write the final progress doc before the route
      // is killed.
      if (Date.now() >= softDeadlineMs) {
        console.log(
          `[Tekmetric Full-Page Backfill] Shop ${shopId}: soft deadline hit after ${pagesProcessed} pages, deferring rest to next tick`,
        );
        break;
      }
    }

    // Normalize the batch (populates cached_plans, work_orders normalized
    // collections, etc). Same call the chunker uses, so the data shape is
    // identical and downstream consumers don't need to know which path
    // produced the row.
    let normalizedCount = 0;
    if (rosForNormalized.length > 0) {
      try {
        const normalizedResult =
          await ingestionService.ingestWorkOrderBatchWithAllEntities(
            rosForNormalized,
          );
        normalizedCount =
          normalizedResult.workOrders.created +
          normalizedResult.workOrders.updated;
      } catch (normErr: any) {
        console.error(
          `[Tekmetric Full-Page Backfill] Shop ${shopId}: normalized ingestion error:`,
          normErr,
        );
      }
    }

    const now = new Date();
    const complete = reachedEnd && !lastError;

    const update: any = {
      $set: {
        fullPageMode: !complete,
        fullPageNextPage: page,
        lastRunAt: now,
        lastFullPageRunAt: now,
      },
      $inc: {
        totalJobsIndexed: jobsIndexed,
      },
    };
    // Same totalPages=0 guard as the per-page write above.
    if (totalPages > 0) update.$set.fullPageTotalPages = totalPages;
    if (complete) {
      update.$set.completed = true;
      update.$set.complete = true;
      update.$set.completedAt = now;
      update.$set.needsFullPageReindex = false;
      update.$set.fullPageCompletedAt = now;
      update.$set.lastError = null;
      update.$set.lastErrorAt = null;
    } else if (lastError) {
      update.$set.lastError = `full-page chunk error: ${lastError.slice(0, 400)}`;
      update.$set.lastErrorAt = now;
    } else {
      update.$set.lastError = null;
      update.$set.lastErrorAt = null;
    }

    await db
      .collection("tekmetric_backfill_progress")
      .updateOne({ shopId }, update);

    if (complete) {
      await db
        .collection("shops")
        .updateOne(
          { shopId },
          {
            $set: {
              tekmetricBackfillComplete: true,
              tekmetricBackfillCompletedAt: now,
            },
          },
        );
    }

    const durationMs = Date.now() - startedAt;
    console.log(
      `[Tekmetric Full-Page Backfill] Shop ${shopId}: pages ${startPage}..${page - 1} of ${totalPages || "?"}, ${rosFetched} ROs, ${jobsIndexed} jobs indexed, ${jobsSkipped} unchanged, ${normalizedCount} normalized, vehiclesCache=${vehiclesCacheHits}/${vehiclesCacheHits + vehiclesCacheMisses}, customersCache=${customersCacheHits}/${customersCacheHits + customersCacheMisses}, ${durationMs}ms${complete ? " — COMPLETE" : ""}`,
    );

    return {
      ok: !lastError,
      complete,
      pagesProcessed,
      startPage,
      endPage: page - 1,
      totalPages,
      rosFetched,
      jobsIndexed,
      jobsSkipped,
      normalizedCount,
      message: complete
        ? `Full-page reindex complete: ${rosFetched} ROs in this run, ${jobsIndexed} jobs indexed`
        : lastError
          ? `Full-page chunk error after ${pagesProcessed} pages: ${lastError}`
          : `Full-page chunk: pages ${startPage}..${page - 1} of ${totalPages}, ${jobsIndexed} jobs indexed`,
      error: lastError || undefined,
    };
  });
  _metricRos = _result.rosFetched ?? 0;
  _metricOutcome = _result.error
    ? "error"
    : _result.complete
      ? "complete"
      : _result.rosFetched === 0
        ? "empty"
        : "ok";
  return _result;
  } catch (err) {
    _metricOutcome = "error";
    throw err;
  } finally {
    await recordChunkMetric({
      provider: "tekmetric-fullpage",
      shopId,
      chunkStartedAt: _metricStartedAt,
      rosProcessed: _metricRos,
      outcome: _metricOutcome,
      counters: chunkWriteCounters,
    });
  }
  });
}

/**
 * Probe Tekmetric for `totalElements` (no date filter) so callers can
 * compare against the indexed RO count and detect "low-coverage" shops.
 * Returns null on failure — callers should treat that as "couldn't check"
 * rather than "no ROs available".
 */
export async function probeTekmetricRoCount(
  shopId: number,
  tekmetricShopId: number,
): Promise<number | null> {
  try {
    const result = await tekmetricRequest<{ totalElements?: number }>(
      `/repair-orders?shop=${tekmetricShopId}&page=0&size=1`,
      shopId,
    );
    if (!result.ok || !result.data) return null;
    return typeof result.data.totalElements === "number"
      ? result.data.totalElements
      : null;
  } catch {
    return null;
  }
}

/**
 * Mark a shop for full-page reindex. Clears completion flags so the cron
 * picks it up and the chunker's early-return guard defers to the full-page
 * worker. Idempotent.
 */
export async function flagShopForFullPageReindex(
  db: any,
  shopId: number,
  reason: string,
): Promise<void> {
  const now = new Date();
  await db.collection("tekmetric_backfill_progress").updateOne(
    { shopId },
    {
      $set: {
        shopId,
        fullPageMode: true,
        fullPageNextPage: 0,
        needsFullPageReindex: true,
        fullPageQueuedAt: now,
        fullPageQueueReason: reason.slice(0, 300),
        completed: false,
        complete: false,
        lastError: null,
        lastErrorAt: null,
      },
      $unset: {
        completedAt: "",
        fullPageCompletedAt: "",
      },
      $setOnInsert: {
        startedAt: now,
        logicVersion: 2,
      },
    },
    { upsert: true },
  );
  await db
    .collection("shops")
    .updateOne({ shopId }, { $set: { tekmetricBackfillComplete: false } });
}
