import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import pLimit from "p-limit";
import crypto from "crypto";
import { createIngestionService } from "@/lib/integrations/core/normalized-ingestion";
import { tekmetricRequest as centralTekmetricRequest, runWithTekmetricApiCallTracking, getRepairOrderInspectionsWithXAuth, runWithTekmetric429Tracking, runWithTekmetricAbortSignal } from "@/lib/integrations/tekmetric/client";
import { getCachedVehicle, cacheVehicle, getCachedCustomer, cacheCustomer, getCachedJobs, cacheJobs } from "@/lib/integrations/tekmetric/incremental-sync";
import { getPaceConfig, midpoint, describePace, getBackfillYears, reopenCompletedShopsForHorizon } from "@/lib/integrations/backfill-pace";
import { prepareQuietWindowGate, applyQuietWindowGate } from "@/lib/data/repositories/activity-profiles";
import { archiveResolvedSkippedRos } from "@/lib/integrations/tekmetric/skipped-ro-resolution";
import {
  getDrainLock,
  getProgress,
  listProgress,
  queryProgress,
  updateProgressFields,
  updateManyProgress,
  autoClearProgressErrors,
} from "@/lib/data/repositories/tekmetric-ops";
import { bulkCacheJobs, bulkFetchJobsByShopWindow, isBulkJobsPrewarmEnabledForShop } from "@/lib/integrations/tekmetric/bulk-jobs";
import { probeTekmetricRoCount, getPrePassVehicle, getPrePassCustomer } from "@/lib/integrations/tekmetric/full-page-backfill";
import { syncTekmetricRoster } from "@/lib/integrations/tekmetric/sync-roster";
import { syncProtractorRoster } from "@/lib/integrations/protractor/sync-roster";
import { decideChunkAdvance } from "@/lib/integrations/tekmetric/backfill-chunk-advance";
import { DEFAULT_STALE_HEARTBEAT_MS } from "@/lib/integrations/tekmetric/inflight-lock";

// Coverage probe: shops with this many Tekmetric ROs available but a low
// indexed-ratio (see COVERAGE_MIN_RATIO) get auto-flagged for full-page
// reindex instead of being marked complete. Catches shops whose entire
// history was bulk-migrated into Tekmetric in the last few weeks (Casey,
// Duxler) — every RO has a recent updatedDate, so the 90-day window
// chunker walks back through 18 empty windows and falsely declares done.
const COVERAGE_PROBE_MIN_TOTAL = 5000;
const COVERAGE_MIN_RATIO = 0.3;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;
// Process multiple shops per run to clear the long tail of stalled shops.
// Concurrency is capped per shop in `getPaceConfig` so the global API
// fan-out stays well under the 600 req/min Tekmetric quota.
//
// Bumped 5→10→15 (and slot splits 2/3 → 4/6 → 6/9 below) after the
// Render Pro upgrade gave us 4GB / 2 CPUs of headroom. Parallelism
// also bumped 3→5 so wall-clock stays bounded: 15 shops / 5-parallel
// × ~5 min/chunk ≈ 15 min, well under the 25-min timeoutMs.
// Combined with the 15-min weekend cadence in lib/cron/jobs.cjs this
// is ~12x throughput vs. the original hourly/5-shop config. The
// 5 RPS local rate-limit cap in lib/integrations/tekmetric/client.ts
// remains the ultimate API throttle.
const MAX_SHOPS_PER_RUN = 15;
const SHOP_PARALLELISM = 5;
// Shops created within this many days are eligible for the every-5-min
// `fastpath=newShops` cycle. Env-tunable so we can dial the "new shop
// honeymoon" window without a redeploy.
const NEW_SHOP_FASTPATH_DAYS = Math.max(
  1,
  Number(process.env.TEKMETRIC_NEW_SHOP_FASTPATH_DAYS) || 14,
);
// Smaller per-tick budget for fastpath so it stays light (it fires 3x
// as often as the weekend boost) and keeps the focus on the handful
// of shops that are genuinely brand-new.
const FASTPATH_MAX_SHOPS_PER_RUN = 3;
// Fastpath idempotence cooldown (task #966): a fastpath tick skips any
// new shop whose last chunk attempt is younger than this, so back-to-back
// 5-min ticks can't re-kick a shop the previous tick just worked. Kept
// just under the 5-min cadence so a healthy shop still gets a chunk
// nearly every tick.
const FASTPATH_RECENT_ATTEMPT_MINUTES = Math.max(
  1,
  Number(process.env.TEKMETRIC_FASTPATH_COOLDOWN_MINUTES) || 4,
);
// Roster sync (Task #632): upcoming appointments + current employee roster.
// Runs as a separate, lightweight pass over ALL connected Tekmetric shops
// (independent of the backfill queue) so it also keeps *completed* shops
// fresh. Staleness-gated so each shop refreshes at most every
// ROSTER_SYNC_STALE_HOURS, and bounded per tick so it never crowds out the
// backfill budget. Bookkeeping (lastRosterSyncAt) lives in a dedicated Mongo
// collection keyed by shopId.
const ROSTER_SYNC_STALE_HOURS = Math.max(
  1,
  Number(process.env.TEKMETRIC_ROSTER_SYNC_STALE_HOURS) || 6,
);
const ROSTER_SYNC_MAX_SHOPS_PER_RUN = Math.max(
  1,
  Number(process.env.TEKMETRIC_ROSTER_SYNC_MAX_SHOPS) || 10,
);
const ROSTER_SYNC_PARALLELISM = 3;
const ROSTER_SYNC_COLLECTION = "tekmetric_roster_sync";
// Protractor roster sync (Task #635). Same staleness-gated, bounded pass as the
// Tekmetric one above, but over connected Protractor shops and into a dedicated
// bookkeeping collection so the two providers' cursors never collide.
const PROTRACTOR_ROSTER_SYNC_STALE_HOURS = Math.max(
  1,
  Number(process.env.PROTRACTOR_ROSTER_SYNC_STALE_HOURS) || 6,
);
const PROTRACTOR_ROSTER_SYNC_MAX_SHOPS_PER_RUN = Math.max(
  1,
  Number(process.env.PROTRACTOR_ROSTER_SYNC_MAX_SHOPS) || 10,
);
const PROTRACTOR_ROSTER_SYNC_PARALLELISM = 2;
const PROTRACTOR_ROSTER_SYNC_COLLECTION = "protractor_roster_sync";
// If a shop's lastError was set more than this many hours ago, clear it
// before the next run so a transient failure can't permanently freeze the
// cursor without anyone noticing.
const ERROR_AUTO_CLEAR_HOURS = 6;
// If a shop has a lastRunAt but its cursor hasn't moved in this many days,
// flag it as stuck in the diagnostics endpoint.
const STUCK_CURSOR_DAYS = 3;
// Entries on `recentSkippedRos` whose `at` timestamp is older than this many
// days get auto-archived to `tekmetric_skipped_ro_archive` with stale=true
// and dropped from the live rolling window. Without this sweep, an RO that
// the cursor has advanced past and is never re-fetched again would linger on
// the admin sync-health view forever, polluting actionable signal with cold
// data. 30 days lines up with the retry cron's give-up window.
const STALE_SKIPPED_RO_DAYS = 30;
// If the same chunk window errors this many cron cycles in a row, force
// the cursor past it so one persistently bad window can't permanently
// freeze a shop (e.g. shop 63's "chunk had errors, holding cursor" loop
// where auto-clear flips the error off but the next attempt re-errors
// immediately on the same window).
const MAX_CONSECUTIVE_CHUNK_ERRORS = 3;
// When a chunk fails AND it racked up meaningful 429 backoff, treat it as a
// throttling failure (rate-limited), NOT bad data. Instead of holding the full
// window and eventually FORCE_SKIPping it (which leaves a permanent history
// gap), shrink the window span and retry the SAME chunk end so a smaller slice
// can complete under the shared rate limit. The shrink halves each failed run
// down to MIN_CHUNK_DAYS_ON_ERROR, then clears back to normal once a chunk
// succeeds. Rate-limited failures do NOT count toward the FORCE_SKIP threshold.
const RATE_LIMIT_SHRINK_BACKOFF_MS = 5000;
const MIN_CHUNK_DAYS_ON_ERROR = 15;
// Bad-data (window read) failures don't shrink for throughput — they bisect to
// isolate the corrupt slice, then force-skip only that minimal slice. A much
// smaller floor keeps any surviving force-skip's blast radius tiny (a couple of
// days) instead of dropping a whole ~90-day window over one bad record.
const MIN_CHUNK_DAYS_ON_BAD_DATA = 2;
// Slot allocation per cron run. Splitting the budget between
// never-started shops and the longest-stalled shops prevents either
// bucket from starving the other. With 19 never-started shops and an
// MAX_SHOPS_PER_RUN of 5, an unsplit budget meant the long-stalled
// (32, 36, 37, ...) bucket waited 4+ runs to even be eligible.
const NEVER_STARTED_SLOTS_PER_RUN = 6;
const STALLED_SLOTS_PER_RUN = 9;
// Per-chunk metrics rolling window. Each chunk records wall-clock + cache
// hit rates + 429 backoff so the admin sync-health view can compute
// median/p95 chunk duration per shop without grepping cron logs. 25 entries
// is enough headroom to spot a regression while keeping the progress doc
// small (each entry is ~200 bytes → ~5KB cap per shop).
const RECENT_CHUNK_METRICS_LIMIT = 25;

type TekmetricRepairOrder = {
  id: number;
  repairOrderNumber: string;
  vehicleId?: number;
  customerId?: number;
  repairOrderStatus?: { code: string };
  createdDate?: string;
  postedDate?: string;
  completedDate?: string;
  updatedDate?: string;
  milesIn?: number;
  milesOut?: number;
};

type TekmetricJob = {
  id: number;
  name: string;
  laborTotal?: number;
  partsTotal?: number;
  subtotal?: number;
  laborHours?: number;
  labor?: { name: string; hours: number; rate: number }[];
  parts?: { partNumber: string; name: string; brand?: string; quantity: number; retailCost: number }[];
};

type TekmetricVehicle = {
  id: number;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  engine?: string;
};

type TekmetricCustomer = {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
};

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    // Task #608: include authorization so existing rows get rewritten with the
    // new `authorized` field on the next backfill pass (declined-job fix).
    authorized: entry.authorized ?? null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(hashContent)).digest("hex").slice(0, 16);
}

// Wrapper that forwards the MOS shopId for proper per-shop attribution in
// the api_usage tracker. Without this, every backfill call gets bucketed as
// "Shop #null" and we lose visibility into who's burning the Tekmetric quota.
async function tekmetricRequest<T>(endpoint: string, shopId?: number, _retries = 3): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    // Date-window backfill is background work — yield rate-limit slots to
    // interactive VHI/dashboard requests so techs aren't waiting behind a
    // chunk's bursty fan-out.
    const data = await centralTekmetricRequest<T>(endpoint, {}, shopId, false, false, 'background');
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

type ShopToBackfill = {
  shopId: number;
  name: string;
  tekmetricShopId: number;
  hasLastRunAt: boolean;
};

async function getShopsNeedingBackfill(db: any): Promise<ShopToBackfill[]> {
  // Horizon-raise reopen: if the operator raised BACKFILL_HORIZON_YEARS, a shop
  // already marked complete under the shorter horizon may still have deeper
  // history to walk. Clear its completion flags first (constrained to linked
  // shops so orphan rows aren't churned) so the completion-filtered query below
  // re-includes it this same tick and it resumes from its parked cursor.
  const linkedForReopen = await db
    .collection("shops")
    .find({
      $or: [
        { "tekmetric.shopId": { $exists: true, $ne: null } },
        { "tekmetricShopId": { $exists: true, $ne: null } },
      ],
    })
    .project({ shopId: 1 })
    .toArray();
  await reopenCompletedShopsForHorizon({
    db,
    progressCollection: "tekmetric_backfill_progress",
    providerLabel: "Tekmetric Backfill",
    shopFlagField: "tekmetricBackfillComplete",
    eligibleShopIds: linkedForReopen
      .map((s: any) => Number(s.shopId))
      .filter((n: number) => Number.isFinite(n)),
  });

  // Only fetch shops that don't have the completion flag set
  const shops = await db.collection("shops").find({
    $or: [
      { "tekmetric.shopId": { $exists: true, $ne: null } },
      { "tekmetricShopId": { $exists: true, $ne: null } }
    ],
    tekmetricBackfillComplete: { $ne: true }
  }).toArray();

  // Auto-recover from held cursors: clear lastError on any shop whose error
  // is older than ERROR_AUTO_CLEAR_HOURS so the next run will retry. Without
  // this, a single bad chunk can hold the cursor indefinitely while the
  // shop stays out of sight.
  const autoClearCutoff = new Date(Date.now() - ERROR_AUTO_CLEAR_HOURS * 60 * 60 * 1000);
  // Preserve `lastError` on shops at or past the force-skip threshold
  // (task #449 / diagnosis #443). Auto-clearing the latest concrete failure
  // message while the counter is still elevated was hiding the diagnostic
  // signal — the sync-health view would show `lastError=null` even though
  // the shop was repeatedly errored on the same window. Once the counter
  // resets (chunk advances cleanly or force-skip moves the cursor past the
  // bad window) the next run will clear `lastError` itself via the
  // chunk-handler write below.
  await autoClearProgressErrors(autoClearCutoff, MAX_CONSECUTIVE_CHUNK_ERRORS);

  // Orphan sweep: a progress row whose shop has had its Tekmetric link
  // removed (no `tekmetric.shopId` and no `tekmetricShopId`) will never be
  // picked up by the queue below — but it still shows up in verification
  // diagnostics as `never_started`, polluting the signal. Mark such rows
  // completed with a noted reason so they drop out of the active set.
  const linkedShopIds = new Set<number>(
    shops
      .filter((s: any) => (s.tekmetric?.shopId ?? s.tekmetricShopId) != null)
      .map((s: any) => Number(s.shopId))
  );
  const orphanRows = await queryProgress({ notCompleted: true });
  const orphanIds = orphanRows
    .map((r: any) => Number(r.shopId))
    .filter((id: number) => !linkedShopIds.has(id));
  if (orphanIds.length > 0) {
    const now = new Date();
    await updateManyProgress(
      { shopIds: orphanIds },
      {
        complete: true,
        completed: true,
        completedAt: now,
        lastError: "shop has no Tekmetric link; marking complete to drop from queue",
        lastErrorAt: now,
      },
    );
    console.log(`[Tekmetric Backfill] Orphan sweep: marked ${orphanIds.length} progress row(s) complete (no Tekmetric link): ${orphanIds.join(",")}`);
  }

  const shopsToBackfill: {
    shopId: number;
    name: string;
    tekmetricShopId: number;
    progressDate: Date | null;
    lastRunAt: Date | null;
  }[] = [];

  for (const shop of shops) {
    const shopId = Number(shop.shopId);
    const tekmetricShopId = shop.tekmetric?.shopId || shop.tekmetricShopId;
    if (!tekmetricShopId) continue;

    const progress = await getProgress(shopId);

    // Include shops that are not completed OR have outdated logic version
    const needsReprocess = !progress?.completed || progress?.logicVersion !== 2;

    if (needsReprocess) {
      shopsToBackfill.push({
        shopId,
        name: shop.name || shop.locationIdentifier || `Shop ${shopId}`,
        tekmetricShopId: Number(tekmetricShopId),
        progressDate: progress?.currentChunkEnd ? new Date(progress.currentChunkEnd) : null,
        lastRunAt: progress?.lastRunAt ? new Date(progress.lastRunAt) : null,
      });
    }
  }

  // Fair-queue ordering to prevent starvation:
  //   1. Shops that have NEVER run (lastRunAt missing) go first.
  //   2. Then by oldest lastRunAt — the longest-stalled shop is next up.
  //   3. Tie-break by furthest-from-complete cursor (newer chunkEnd =
  //      less progress made, so prioritize it over a shop that's almost
  //      done and only needs a small final push).
  // The previous implementation sorted un-started shops by *most recent*
  // cursor, which meant freshly-onboarded shops perpetually displaced the
  // long-stalled tail.
  //
  // !!! IMPORTANT for probe / restart helpers (see task #46) !!!
  // `lastRunAt` here is the ordering key. A one-off probe script that
  // stamps `lastRunAt = now` will silently demote the shop from the
  // high-priority "never_started" bucket to the bottom of the "stalled"
  // bucket, where it may wait many cron cycles before being picked up.
  // Probes MUST record their outcome on `lastProbedAt` / `lastProbeError`
  // / `lastProbeOk` instead — only real chunk attempts inside
  // `backfillShopChunkInner` are allowed to write `lastRunAt` /
  // `lastError`. The original task #23 restart script violated this and
  // had to be unstuck by bypassing the cron entirely (task #36); the
  // safe pattern now lives in `lib/integrations/tekmetric/probe.ts`
  // (`probeTekmetricShop` + `recordProbeResult`), exposed on-call via
  // `scripts/probe-tekmetric-shop.ts`. Both carry the regression-guard
  // comment.
  shopsToBackfill.sort((a, b) => {
    if (!a.lastRunAt && b.lastRunAt) return -1;
    if (a.lastRunAt && !b.lastRunAt) return 1;
    if (a.lastRunAt && b.lastRunAt) {
      const diff = a.lastRunAt.getTime() - b.lastRunAt.getTime();
      if (diff !== 0) return diff;
    }
    // Tie-break: shop with the newer (further-from-complete) cursor first.
    const aMs = a.progressDate ? a.progressDate.getTime() : Number.POSITIVE_INFINITY;
    const bMs = b.progressDate ? b.progressDate.getTime() : Number.POSITIVE_INFINITY;
    return bMs - aMs;
  });

  return shopsToBackfill.map(s => ({
    shopId: s.shopId,
    name: s.name,
    tekmetricShopId: s.tekmetricShopId,
    hasLastRunAt: s.lastRunAt != null,
  }));
}

// Sweep `recentSkippedRos` for entries whose `at` timestamp is older than
// STALE_SKIPPED_RO_DAYS. The auto-resolve path only clears entries when the
// cron re-fetches the RO, so if the cursor has advanced past their window
// they linger indefinitely. Move them into `tekmetric_skipped_ro_archive`
// with `stale: true` and drop them from the live rolling window so the
// admin sync-health view stays focused on actionable items.
async function sweepStaleSkippedRos(
  db: any,
): Promise<{ shopsTouched: number; entriesArchived: number }> {
  const cutoffMs = Date.now() - STALE_SKIPPED_RO_DAYS * 24 * 60 * 60 * 1000;
  const rows = await queryProgress({ hasRecentSkippedRos: true });

  const now = new Date();
  let shopsTouched = 0;
  let entriesArchived = 0;

  for (const row of rows) {
    const entries: any[] = Array.isArray(row.recentSkippedRos)
      ? row.recentSkippedRos
      : [];
    const stale: any[] = [];
    const fresh: any[] = [];
    for (const e of entries) {
      const atMs = e?.at ? new Date(e.at).getTime() : NaN;
      // Treat entries with a missing/invalid `at` as stale too — they're
      // ancient leftovers from before the timestamp was recorded and can't
      // be acted on otherwise.
      if (!Number.isFinite(atMs) || atMs < cutoffMs) {
        stale.push(e);
      } else {
        fresh.push(e);
      }
    }
    if (stale.length === 0) continue;

    try {
      const archiveDocs = stale.map((e: any) => ({
        shopId: row.shopId,
        roId: e.roId,
        error: e.error || null,
        skippedAt: e.at || null,
        retryAttempts: Number(e.retryAttempts || 0),
        lastRetryAt: e.lastRetryAt || null,
        lastRetryError: e.lastRetryError || null,
        permanentlyFailed: !!e.permanentlyFailed,
        stale: true,
        archivedAt: now,
        archiveReason: `never_re_fetched_in_${STALE_SKIPPED_RO_DAYS}d`,
      }));
      await db
        .collection("tekmetric_skipped_ro_archive")
        .insertMany(archiveDocs, { ordered: false });
      // Only drop from the live list AFTER archive write succeeds so a
      // Mongo blip can't silently destroy the postmortem record.
      await updateProgressFields(
        Number(row.shopId),
        {
          recentSkippedRos: fresh,
          lastStaleSkippedRosArchivedAt: now,
        },
        { incFields: { staleSkippedRosArchivedTotal: stale.length } },
      );
      shopsTouched++;
      entriesArchived += stale.length;
      console.log(
        `[Tekmetric Backfill] Stale sweep: archived ${stale.length} stale RO(s) for shop ${row.shopId} (ids: ${stale.map((s: any) => s.roId).join(",")})`,
      );
    } catch (err: any) {
      console.warn(
        `[Tekmetric Backfill] Stale sweep failed for shop ${row.shopId}; leaving on recentSkippedRos: ${err?.message || err}`,
      );
    }
  }

  if (entriesArchived > 0) {
    console.log(
      `[Tekmetric Backfill] Stale sweep complete: archived ${entriesArchived} entries across ${shopsTouched} shop(s)`,
    );
  }
  return { shopsTouched, entriesArchived };
}

// Exported so one-off scripts can call it directly without going through HTTP
// (e.g. scripts/drive-task-23-restarted-shops.ts, scripts/drive-one-shop.ts).
// Next.js ignores named exports from a route handler other than HTTP method
// names.
export async function backfillShopChunk(
  db: any,
  shopId: number,
  tekmetricShopId: number,
  // Optional hard-cancel signal. When the drain script's two-stage SIGINT
  // fires (or 30s graceful timeout), the worker calls `controller.abort()`
  // on its per-worker controller. The signal is bound via AsyncLocalStorage
  // (see `runWithTekmetricAbortSignal`) so every Tekmetric `fetch` issued
  // under this chunk forwards it; an in-flight 100-min chunk rejects
  // promptly with AbortError instead of running to completion.
  signal?: AbortSignal,
  // Optional heartbeat fired after each page of ROs is processed. The drain
  // worker uses this to bump its progress watchdog at page granularity so a
  // legitimately-slow (but advancing) 50-100 page chunk isn't mistaken for a
  // wedge — only a chunk that completes no page for the stall window is killed.
  onPageProgress?: () => void,
): Promise<{ jobsIndexed: number; skipped: number; complete: boolean; message: string; normalizedCount: number }> {
  const run = () => backfillShopChunkInner(db, shopId, tekmetricShopId, onPageProgress);
  try {
    return signal ? await runWithTekmetricAbortSignal(signal, run) : await run();
  } catch (err: any) {
    // Operator-initiated hard-cancel (drain script SIGINT). Don't pollute
    // the progress row's `lastError` with "chunk threw: aborted" — that
    // would show up in admin diagnostics as a real failure and trigger
    // the auto-clear sweep timer for nothing. Just bubble the AbortError
    // up to the worker, which already maps it to a "stopped" outcome.
    if (err?.name === "AbortError" || signal?.aborted) {
      throw err;
    }
    // The inner function may throw between the init-row upsert and the
    // final progress write. Without recording the failure here, the shop
    // ends up with a progress row but no `lastRunAt` / `lastError`, which
    // makes it indistinguishable from a brand-new "never started" shop and
    // hides the real failure mode. Surface it so diagnostics catch it.
    const now = new Date();
    const errMessage = err?.message ? String(err.message).slice(0, 500) : String(err).slice(0, 500);
    try {
      await updateProgressFields(
        shopId,
        {
          shopId,
          lastRunAt: now,
          lastError: `chunk threw: ${errMessage}`,
          lastErrorAt: now,
        },
        { upsert: true },
      );
    } catch (writeErr) {
      console.error(`[Tekmetric Backfill] Shop ${shopId}: failed to record chunk error to progress row:`, writeErr);
    }
    throw err;
  }
}

async function backfillShopChunkInner(
  db: any,
  shopId: number,
  tekmetricShopId: number,
  onPageProgress?: () => void
): Promise<{ jobsIndexed: number; skipped: number; complete: boolean; message: string; normalizedCount: number }> {
  // Per-chunk speed metrics. Captured here and persisted at the end of the
  // chunk so a regression in /jobs cache hit rate or a 429 backoff spike is
  // visible in the admin sync-health view without grepping cron logs. The
  // 429 backoff is scoped to *this* chunk via AsyncLocalStorage (see
  // `runWithTekmetric429Tracking` in tekmetric/client.ts) so concurrent
  // shops backfilling in parallel don't leak each other's 429 waits into
  // this chunk's metric.
  //
  // Task #460: also wrap the chunk in `withChunkWriteCounters` so PG /
  // Mongo / rate-limiter write-fan-out is captured in
  // `backfill_chunk_metrics` for cadence-ceiling measurement. The
  // counters are AsyncLocalStorage-scoped so they only fire for the
  // chunk's own call chain.
  const { withChunkWriteCounters } = await import("@/lib/backfill-metrics/write-counters");
  const { recordChunkMetric } = await import("@/lib/backfill-metrics/chunk-metrics");
  return withChunkWriteCounters(async (chunkWriteCounters) => {
  const _metricStartedAt = Date.now();
  let _metricOutcome: "ok" | "error" | "deferred" | "complete" | "empty" = "ok";
  let _metricRos = 0;
  let _metricBackoffMs = 0;
  try {
  return await runWithTekmetric429Tracking(async (chunkBackoffCounter) => {
  const chunkStartedAt = Date.now();
  let jobsCacheHits = 0;
  let jobsCacheMisses = 0;
  let vehiclesCacheHits = 0;
  let vehiclesCacheMisses = 0;
  let customersCacheHits = 0;
  let customersCacheMisses = 0;
  // Bulk pre-pass hit/miss counters (task #413). Distinct from the
  // umbrella vehiclesCacheHits/Misses so on-call can confirm in the
  // admin sync-health view that the bulk pre-pass cache is the path
  // doing the work, vs. just the legacy 24h TTL'd per-RO cache.
  // `*PrePassMisses` only increments when prePassDoneForShop is true
  // — i.e. the pre-pass cache was checked and didn't have the row,
  // forcing fall-through to the legacy cache or API. A high miss rate
  // here on a "done" pre-pass means new vehicles/customers landed
  // after the pre-pass walked and we'll need a refresh pass.
  let vehiclesPrePassHits = 0;
  let vehiclesPrePassMisses = 0;
  let customersPrePassHits = 0;
  let customersPrePassMisses = 0;

  let progress: any = await getProgress(shopId);
  const vehiclesPrePassDoneForShop = !!progress?.vehiclesPrePassDone;
  const customersPrePassDoneForShop = !!progress?.customersPrePassDone;

  // Full-page mode short-circuit: when a shop has been flagged for
  // full-page reindex (`fullPageMode: true`) the dedicated
  // `/api/cron/tekmetric-fullpage-backfill` worker owns it. The regular
  // chunker bails out so two cron paths never race writes against the
  // same `tekmetric_backfill_progress` row. Returning a benign no-op
  // shape avoids upsetting the outer queue accounting.
  if (progress?.fullPageMode === true && progress?.completed !== true) {
    console.log(
      `[Tekmetric Backfill] Shop ${shopId}: deferring to full-page worker (fullPageMode=true, nextPage=${progress.fullPageNextPage ?? 0})`,
    );
    _metricOutcome = "deferred";
    return {
      jobsIndexed: 0,
      skipped: 0,
      complete: false,
      message: `deferred to full-page worker (page ${progress.fullPageNextPage ?? 0})`,
      normalizedCount: 0,
    };
  }

  const shop = await db.collection("shops").findOne({ shopId });
  const enterpriseId = shop?.enterpriseId;
  
  const ingestionService = createIngestionService(
    db,
    'tekmetric',
    shopId,
    enterpriseId,
    { 
      syncRunId: `tekmetric-backfill-${Date.now()}`,
      createAuditLog: false,
      dualWriteToJobIndex: true,
      dualWriteToRepairPatterns: true,
    }
  );
  
  // Calculate date boundaries
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  
  const yearsToBackfill = getBackfillYears();
  const oldestDate = new Date();
  oldestDate.setFullYear(oldestDate.getFullYear() - yearsToBackfill);
  oldestDate.setHours(0, 0, 0, 0);
  
  // REVERSE CHRONOLOGICAL: Start from today, work backwards
  let chunkEnd: Date;
  
  if (progress?.currentChunkEnd && progress?.logicVersion === 2) {
    chunkEnd = new Date(progress.currentChunkEnd);
  } else {
    // Fresh start or upgrading from old logic
    chunkEnd = new Date(today);
    await updateProgressFields(
      shopId,
      {
        shopId,
        startedAt: new Date(),
        currentChunkEnd: chunkEnd,
        completed: false,
        logicVersion: 2,
      },
      { upsert: true, unsetFields: ["currentChunkStart"] },
    );
  }

  // Pace config — off-hours boosts concurrency + chunk size
  const pace = getPaceConfig("tekmetric", shop?.timezone, new Date());

  // Calculate chunk start (going backwards). If a prior run shrank this shop's
  // window after a rate-limit failure, honor the smaller span (never larger
  // than the normal pace size) until a chunk succeeds and clears the override.
  const chunkDaysOverride =
    typeof progress?.nextChunkDaysOverride === "number" && progress.nextChunkDaysOverride > 0
      ? Math.min(progress.nextChunkDaysOverride, pace.chunkDays)
      : null;
  const effectiveChunkDays = chunkDaysOverride ?? pace.chunkDays;
  const chunkStart = new Date(chunkEnd);
  chunkStart.setDate(chunkStart.getDate() - effectiveChunkDays);
  if (chunkStart < oldestDate) {
    chunkStart.setTime(oldestDate.getTime());
  }

  // Check if we've reached the oldest date
  if (chunkEnd <= oldestDate) {
    await updateProgressFields(shopId, {
      complete: true,
      completed: true,
      completedAt: new Date(),
    });
    _metricOutcome = "complete";
    return { jobsIndexed: 0, skipped: 0, complete: true, message: "Already complete", normalizedCount: 0 };
  }

  const startStr = chunkStart.toISOString();
  const endStr = chunkEnd.toISOString();

  console.log(`[Tekmetric Backfill] Shop ${shopId}: ${startStr.split("T")[0]} to ${endStr.split("T")[0]} (reverse) horizon=${yearsToBackfill}y ${describePace(pace)}`);

  let jobsIndexed = 0;
  let skippedUnchanged = 0;
  let page = 0;
  let totalPages = 1;
  // Split error signals so a single bad RO can't blow away a whole window.
  //  - chunkHadWindowError: the `/repair-orders` list page itself failed, so we
  //    genuinely couldn't read the window. Only these NARROW/HOLD/FORCE_SKIP the
  //    cursor (and any force-skip is scoped to a minimal, isolated slice).
  //  - chunkHadRecordError: the list read fine and the good ROs were ingested,
  //    but one or more individual ROs threw. Those are recorded on the
  //    skipped-RO list and never force-skip the window.
  // `chunkHadError` stays as the OR of the two for metrics / rate-limit
  // classification continuity.
  let chunkHadWindowError = false;
  let chunkHadRecordError = false;
  let hitPageCap = false;
  let perRoExceptions = 0;
  // Capture the actual RO ids + error messages that threw so on-call can see
  // WHICH repair orders are throwing without grepping cron logs. These get
  // persisted on the progress doc and surfaced in the admin sync-health view.
  const skippedRoSamples: { roId: number; error: string; at: Date }[] = [];
  const seenROIds = new Set<number>();
  // RO ids that were re-fetched without throwing this run. Used to confirm
  // recovery for entries on the persisted `recentSkippedRos` list so a shop
  // that had a transient burst and then started succeeding doesn't keep the
  // stale ids on the admin sync-health view forever.
  const reFetchedRoIds = new Set<number>();
  const vehicleCache = new Map<number, TekmetricVehicle>();
  const customerCache = new Map<number, TekmetricCustomer>();
  // Per-chunk in-memory jobs cache so duplicate ROs across pages (rare, but
  // happens around chunk boundaries on updatedDate sort) don't re-hit Mongo.
  const jobsCache = new Map<number, TekmetricJob[]>();
  const limit = pLimit(pace.concurrency);
  const rosForNormalized: any[] = [];

  // Bulk shop-level /jobs pre-pass (task #146). Pulls the entire chunk
  // window's /jobs in shop-level pages of 100 (typically <50 pages for a
  // 90d window) BEFORE the per-RO loop runs, then seeds the per-chunk
  // in-memory `jobsCache` and the persistent `tekmetric_jobs_cache` Mongo
  // collection. The per-RO `/jobs?repairOrderId=…` call below stays in
  // place as a safety-net fallback for any RO whose jobs fell outside
  // the bulk pull's updatedDate window.
  //
  // Per-shop gated: `tekmetric.bulkJobsPrewarm.enabled` is stamped on
  // the shop doc by the prewarm at first-time onboarding, so by design
  // this only runs for shops onboarded after this code shipped. Existing
  // shops keep using the legacy per-RO path until explicitly opted in
  // (set the field to true on the shop doc). The
  // `TEKMETRIC_BULK_JOBS_PREWARM_ENABLED=false` env flag is a separate
  // global kill-switch that overrides every shop to off.
  let bulkJobsPagesFetched = 0;
  let bulkJobsRosSeeded = 0;
  let bulkJobsTotal = 0;
  let bulkJobsApiCallsSaved = 0;
  let bulkJobsCapped = false;
  let bulkJobsErrored = false;
  let bulkJobsEnabledForShop = false;
  // Cheap field-projected read so we don't pay for the full shop doc on
  // every chunk. The flag is the only thing this block needs.
  const shopFlagDoc = await db.collection("shops").findOne(
    { shopId: { $in: [shopId, String(shopId)] } },
    { projection: { "tekmetric.bulkJobsPrewarm": 1 } },
  );
  bulkJobsEnabledForShop = isBulkJobsPrewarmEnabledForShop(shopFlagDoc);
  if (bulkJobsEnabledForShop) {
    try {
      const bulk = await bulkFetchJobsByShopWindow(tekmetricShopId, {
        updatedDateStart: startStr,
        updatedDateEnd: endStr,
      });
      bulkJobsPagesFetched = bulk.pagesFetched;
      bulkJobsTotal = bulk.totalJobs;
      bulkJobsCapped = bulk.capped;
      const cacheEntries: Array<{ repairOrderId: number; jobs: TekmetricJob[] }> = [];
      for (const [roId, jobs] of bulk.jobsByRoId.entries()) {
        const jobsArr = jobs as TekmetricJob[];
        jobsCache.set(roId, jobsArr);
        cacheEntries.push({ repairOrderId: roId, jobs: jobsArr });
      }
      bulkJobsRosSeeded = cacheEntries.length;
      if (cacheEntries.length > 0) {
        await bulkCacheJobs(db, cacheEntries).catch((writeErr: any) => {
          // Mongo write hiccup shouldn't break the chunk — the in-memory
          // cache is already seeded, so the per-RO loop still benefits.
          // The next run will reseed Mongo via the same bulk pre-pass.
          console.warn(
            `[Tekmetric Backfill] Shop ${shopId}: bulk jobs cache write failed (in-memory still seeded): ${writeErr?.message || writeErr}`,
          );
        });
      }
      // API calls saved this chunk vs. the legacy per-RO shape: each
      // bulk-seeded RO would have cost one /jobs call; the bulk path
      // replaced that with `bulk.pagesFetched` paged shop-level calls.
      bulkJobsApiCallsSaved = Math.max(0, bulkJobsRosSeeded - bulk.pagesFetched);
      console.log(
        `[Tekmetric Backfill] Shop ${shopId}: bulk jobs pre-pass — pages=${bulk.pagesFetched} ros=${bulkJobsRosSeeded} jobs=${bulk.totalJobs} ~apiCallsSaved=${bulkJobsApiCallsSaved}${bulk.capped ? " capped=true" : ""}`,
      );
    } catch (err: any) {
      // Bulk pre-pass threw — the per-RO loop below will fall through to
      // the legacy per-RO `/jobs?repairOrderId=…` calls for every RO, so
      // the chunk still completes (just at the slower API cost). Don't
      // mark `chunkHadError` for this — it would hold the cursor on a
      // window that the per-RO path can still process successfully.
      bulkJobsErrored = true;
      console.warn(
        `[Tekmetric Backfill] Shop ${shopId}: bulk jobs pre-pass failed; per-RO fallback will be used for this chunk: ${err?.message || err}`,
      );
    }
  }

  while (page < totalPages && page < pace.maxPagesPerChunk) {
    const queryParams = new URLSearchParams({
      shop: tekmetricShopId.toString(),
      page: page.toString(),
      size: "100",
      updatedDateStart: startStr,
      updatedDateEnd: endStr,
      sort: "updatedDate",
      sortDirection: "DESC",
    });

    const rosResult = await tekmetricRequest<{ content: TekmetricRepairOrder[]; totalPages: number }>(
      `/repair-orders?${queryParams}`,
      shopId,
    );

    if (!rosResult.ok || !rosResult.data) {
      console.error(`[Tekmetric Backfill] Shop ${shopId} page ${page} error:`, rosResult.error);
      // WINDOW-level failure: we couldn't read the list page, so we can't see
      // this window's contents. This is what NARROWs/holds/force-skips the
      // cursor (a single bad RO does NOT reach here).
      chunkHadWindowError = true;
      break;
    }

    totalPages = rosResult.data.totalPages;
    if (totalPages > pace.maxPagesPerChunk && page + 1 >= pace.maxPagesPerChunk) {
      hitPageCap = true;
    }
    const ros = rosResult.data.content || [];

    console.log(`[Tekmetric Backfill] Shop ${shopId} page ${page + 1}/${totalPages}: ${ros.length} ROs`);

    const roPromises = ros.map(ro => limit(async () => {
     try {
      if (seenROIds.has(ro.id)) return { indexed: 0, skipped: 0, roData: null };
      seenROIds.add(ro.id);

      const statusCode = ro.repairOrderStatus?.code?.toUpperCase() || "";
      if (!["POSTED", "INVOICED", "COMPLETED"].includes(statusCode)) {
        // Status filter still counts as a successful re-fetch — the RO list
        // call returned the row, we just chose not to index it.
        reFetchedRoIds.add(ro.id);
        return { indexed: 0, skipped: 0, roData: null };
      }

      let vehicle: TekmetricVehicle | null = null;
      if (ro.vehicleId) {
        if (vehicleCache.has(ro.vehicleId)) {
          vehicle = vehicleCache.get(ro.vehicleId)!;
          vehiclesCacheHits++;
        } else {
          // Lookup chain (cheapest -> most expensive):
          //   1. Bulk pre-pass cache `tekmetric_vehicles_cache`, populated
          //      once per shop by the full-page worker's
          //      `runVehiclesPrePass`. When prePass is done for the shop,
          //      this is a single Mongo read with zero API cost.
          //   2. Legacy 24h TTL'd `tekmetric_vehicle_cache`.
          //   3. Per-RO `/vehicles/{id}` API call (the bottleneck we're
          //      trying to avoid on first-time backfills).
          let prePassVehicle: any = undefined;
          if (vehiclesPrePassDoneForShop) {
            prePassVehicle = await getPrePassVehicle(db, shopId, ro.vehicleId);
          }
          if (prePassVehicle) {
            vehicle = prePassVehicle as TekmetricVehicle;
            vehicleCache.set(ro.vehicleId, vehicle);
            vehiclesCacheHits++;
            vehiclesPrePassHits++;
          } else {
            // Pre-pass coverage metric: count any pre-pass cache miss
            // here (even if the legacy 24h cache or in-memory cache
            // ends up satisfying the lookup). The signal we want is
            // "what fraction of vehicles seen this chunk were already
            // in the bulk pre-pass index" — anything else under-reports
            // pre-pass gaps.
            if (vehiclesPrePassDoneForShop) vehiclesPrePassMisses++;
            // Defensive: a Mongo hiccup on the read used to throw straight
            // out of Promise.all and crash the entire chunk (the RO loop has
            // no per-RO try/catch above). Treat a cache miss/error as
            // "no cached vehicle, fetch from API" so one bad lookup can't
            // freeze the shop. Matches the `.catch(() => {})` already on
            // the cacheVehicle write below.
            const mongoVehicle = await getCachedVehicle(db, ro.vehicleId).catch(err => {
              console.warn(`[Tekmetric Backfill] getCachedVehicle failed for vehicle ${ro.vehicleId}: ${err?.message || err}`);
              return null;
            });
            if (mongoVehicle) {
              vehicle = mongoVehicle as TekmetricVehicle;
              vehicleCache.set(ro.vehicleId, vehicle);
              vehiclesCacheHits++;
            } else {
              vehiclesCacheMisses++;
              const vehResult = await tekmetricRequest<TekmetricVehicle>(`/vehicles/${ro.vehicleId}`, shopId);
              if (vehResult.ok && vehResult.data) {
                vehicle = vehResult.data;
                vehicleCache.set(ro.vehicleId, vehicle);
                await cacheVehicle(db, ro.vehicleId, vehResult.data as any).catch(() => {});
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
            prePassCustomer = await getPrePassCustomer(db, shopId, ro.customerId);
          }
          if (prePassCustomer) {
            customer = prePassCustomer as TekmetricCustomer;
            customerCache.set(ro.customerId, customer);
            customersCacheHits++;
            customersPrePassHits++;
          } else {
            // See vehicles branch above for the rationale on counting
            // pre-pass misses here vs. inside the legacy/API fallback.
            if (customersPrePassDoneForShop) customersPrePassMisses++;
            // Same defensive treatment as getCachedVehicle above.
            const mongoCustomer = await getCachedCustomer(db, ro.customerId).catch(err => {
              console.warn(`[Tekmetric Backfill] getCachedCustomer failed for customer ${ro.customerId}: ${err?.message || err}`);
              return null;
            });
            if (mongoCustomer) {
              customer = mongoCustomer as TekmetricCustomer;
              customerCache.set(ro.customerId, customer);
              customersCacheHits++;
            } else {
              customersCacheMisses++;
              const custResult = await tekmetricRequest<TekmetricCustomer>(`/customers/${ro.customerId}`, shopId);
              if (custResult.ok && custResult.data) {
                customer = custResult.data;
                customerCache.set(ro.customerId, customer);
                await cacheCustomer(db, ro.customerId, custResult.data as any).catch(() => {});
              }
            }
          }
        }
      }

      // Jobs lookup. The pre-cache fast path is the dominant chunk-time
      // optimization: a typical 90-day chunk runs 100s of ROs and each one
      // used to issue an unconditional `/jobs?repairOrderId=…` call, which
      // is exactly what was eating ~14m of wall-clock and triggering the
      // 429 storms during verification reruns. We now check, in order:
      //   1. Per-chunk in-memory map (cheapest)
      //   2. tekmetric_jobs_cache (Mongo, 30d TTL) — survives across runs
      //   3. tekmetric_work_orders.data.jobs — the incremental-sync path
      //      already stores the full jobs payload for terminal ROs, so a
      //      shop whose webhooks/poller saw an RO first never needs to
      //      re-fetch its jobs during backfill.
      //   4. Fall through to the API.
      let jobs: TekmetricJob[] = [];
      if (jobsCache.has(ro.id)) {
        jobs = jobsCache.get(ro.id)!;
        jobsCacheHits++;
      } else {
        const cachedJobs = await getCachedJobs(db, ro.id).catch(err => {
          console.warn(`[Tekmetric Backfill] getCachedJobs failed for RO ${ro.id}: ${err?.message || err}`);
          return null;
        });
        if (cachedJobs) {
          jobs = cachedJobs as TekmetricJob[];
          jobsCache.set(ro.id, jobs);
          jobsCacheHits++;
        } else {
          // Last cache check before the API: incremental sync already
          // stores `data.jobs` on tekmetric_work_orders for terminal ROs.
          const cachedWO = await db.collection("tekmetric_work_orders").findOne(
            {
              shopId: { $in: [String(shopId), Number(shopId)] },
              workOrderId: String(ro.id),
            },
            { projection: { "data.jobs": 1 } }
          ).catch(() => null);
          const woJobs = cachedWO?.data?.jobs;
          if (Array.isArray(woJobs) && woJobs.length > 0) {
            jobs = woJobs as TekmetricJob[];
            jobsCache.set(ro.id, jobs);
            // The work-orders projection IS a cache — it spares us the
            // /jobs API call, which is what the metric is meant to reflect.
            jobsCacheHits++;
            // Promote into the dedicated jobs cache so future runs skip
            // the WO-collection projection cost too.
            await cacheJobs(db, ro.id, jobs).catch(() => {});
          } else {
            jobsCacheMisses++;
            const jobsResult = await tekmetricRequest<{ content: TekmetricJob[] }>(
              `/jobs?shop=${tekmetricShopId}&repairOrderId=${ro.id}`,
              shopId,
            );

            if (!jobsResult.ok) {
              console.warn(`[Tekmetric Backfill] Failed to fetch jobs for RO ${ro.id}: ${jobsResult.error}`);
              // Single-RECORD failure: only this RO couldn't be fetched. Record
              // it on the skipped-RO list and let the rest of the window ingest.
              // A per-RO failure must NOT hold/force-skip the whole window.
              perRoExceptions++;
              chunkHadRecordError = true;
              if (skippedRoSamples.length < 50) {
                skippedRoSamples.push({
                  roId: ro.id,
                  error: `jobs fetch failed: ${String(jobsResult.error ?? "unknown").slice(0, 260)}`,
                  at: new Date(),
                });
              }
              return { indexed: 0, skipped: 0, roData: null };
            }

            jobs = jobsResult.data?.content || [];
            jobsCache.set(ro.id, jobs);
            // Cache even empty arrays — an RO with no jobs is a real,
            // stable state for terminal ROs and the next run shouldn't
            // pay another API call to re-confirm the empty result.
            await cacheJobs(db, ro.id, jobs).catch(() => {});
          }
        }
      }

      if (jobs.length === 0) {
        reFetchedRoIds.add(ro.id);
        return { indexed: 0, skipped: 0, roData: null };
      }

      let inspections: any[] = [];
      const hasInspectionUrl = !!(ro as any).inspectionUrl;
      const inspectionShared = !!(ro as any).inspectionShareDate;
      const backfillXAuthToken = shop?.tekmetric?.xAuthToken || null;
      // Phase C: env-flag gate. Default ON. Flip TEKMETRIC_POLLING_FETCH_INSPECTIONS=false
      // per-env after the Inspection.Complete webhook handler has soaked.
      const pollingFetchEnabled = process.env.TEKMETRIC_POLLING_FETCH_INSPECTIONS !== "false";
      if ((hasInspectionUrl || inspectionShared) && backfillXAuthToken && pollingFetchEnabled) {
        try {
          inspections = await getRepairOrderInspectionsWithXAuth(ro.id, tekmetricShopId, backfillXAuthToken);
        } catch (inspErr: any) {
          console.warn(`[Tekmetric Backfill] Inspection fetch failed for RO ${ro.id}: ${inspErr.message}`);
        }
      }

      // If we got here, the RO was re-fetched (jobs API succeeded). Even if
      // jobs is empty, that's a confirmed successful read of the RO from
      // Tekmetric — enough to clear it off the "recently skipped" list if it
      // was sitting there from a prior burst.
      let indexed = 0;
      let skipped = 0;
      
      for (const job of jobs) {
        const laborAmountDollars = (job.laborTotal || 0) / 100;
        const partsAmountDollars = (job.partsTotal || 0) / 100;

        const roMileage =
          (typeof ro.milesOut === "number" && ro.milesOut > 0 ? ro.milesOut : null) ??
          (typeof ro.milesIn === "number" && ro.milesIn > 0 ? ro.milesIn : null) ??
          (vehicle && typeof (vehicle as any).mileageOut === "number" && (vehicle as any).mileageOut > 0
            ? (vehicle as any).mileageOut
            : null) ??
          (vehicle && typeof (vehicle as any).mileageIn === "number" && (vehicle as any).mileageIn > 0
            ? (vehicle as any).mileageIn
            : null) ??
          null;

        const entry = {
          shopId,
          sourceSystem: "tekmetric",
          workOrderId: String(ro.id),
          workOrderNumber: ro.repairOrderNumber,
          servicePackageId: String(job.id),
          jobName: job.name,
          closedAt: ro.postedDate || ro.completedDate || ro.updatedDate,
          mileage: roMileage,
          // Task #608: declined jobs must never anchor an interval.
          ...(typeof job.authorized === "boolean" ? { authorized: job.authorized } : {}),
          vehicle: vehicle ? {
            vin: vehicle.vin,
            year: vehicle.year,
            make: vehicle.make,
            model: vehicle.model,
            engine: vehicle.engine,
            mileage: roMileage,
          } : null,
          customer: customer ? {
            name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim(),
            email: customer.email,
            phone: customer.phone,
          } : null,
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
              extendedPrice: ((part.quantity || 1) * (part.retailCost || 0)) / 100,
            });
          }
        }

        // Compute content hash for change detection
        const contentHash = computeContentHash(entry);
        const filter = { shopId, workOrderId: String(ro.id), servicePackageId: String(job.id) };
        
        // Check if record exists with same hash
        const existing = await db.collection("job_index").findOne(filter);
        
        if (existing && existing.contentHash === contentHash) {
          skipped++;
          continue;
        }

        await db.collection("job_index").updateOne(
          filter,
          { $set: { ...entry, contentHash } },
          { upsert: true }
        );
        indexed++;
      }

      const roDataForNormalized = {
        id: ro.id,
        repairOrderNumber: ro.repairOrderNumber,
        repairOrderStatus: ro.repairOrderStatus?.code || ro.repairOrderStatus,
        postedDate: ro.postedDate,
        completedDate: ro.completedDate,
        createdDate: ro.createdDate,
        updatedDate: ro.updatedDate,
        milesIn: ro.milesIn,
        milesOut: ro.milesOut,
        laborSubtotal: jobs.reduce((sum, j) => sum + (j.laborTotal || 0), 0),
        partsSubtotal: jobs.reduce((sum, j) => sum + (j.partsTotal || 0), 0),
        total: jobs.reduce((sum, j) => sum + (j.subtotal || 0), 0),
        vehicle: vehicle,
        customer: customer,
        jobs: jobs.map(j => ({
          id: j.id,
          name: j.name,
          laborTotal: (j.laborTotal || 0) / 100,
          partsTotal: (j.partsTotal || 0) / 100,
          total: (j.subtotal || 0) / 100,
          laborHours: j.laborHours || 0,
          labor: j.labor,
          parts: j.parts,
        })),
        inspections: inspections.length > 0 ? inspections : [],
        inspectionUrl: (ro as any).inspectionUrl || null,
        inspectionShareDate: (ro as any).inspectionShareDate || null,
        rawPayload: { repairOrder: ro, vehicle, customer, jobs, inspections: inspections.length > 0 ? inspections : undefined },
      };
      
      reFetchedRoIds.add(ro.id);
      return { indexed, skipped, roData: roDataForNormalized };
     } catch (roErr: any) {
      // Per-RO safety net. Without this, an unexpected throw inside the
      // RO body (Mongo write failure on job_index, schema-shape surprise,
      // unwrapped helper, etc.) propagates out of Promise.all and crashes
      // the whole chunk — which is the exact failure mode that landed
      // shops in the GET handler's "unhandled chunk exception" branch.
      // Single-RECORD failure: mark chunkHadRecordError (NOT a window error) so
      // the rest of the page's ROs still finish and the good data ingests. The
      // bad RO is recorded below on the skipped-RO list; a per-RO throw must
      // never hold or force-skip the whole window.
      perRoExceptions++;
      chunkHadRecordError = true;
      const roErrMsg = (roErr?.message || String(roErr)).slice(0, 300);
      // Cap the per-chunk sample so a runaway chunk doesn't blow up the
      // progress doc. The aggregate count (perRoExceptions) is always exact.
      if (skippedRoSamples.length < 50) {
        skippedRoSamples.push({ roId: ro.id, error: roErrMsg, at: new Date() });
      }
      console.warn(
        `[Tekmetric Backfill] Shop ${shopId} RO ${ro.id} threw, skipping: ${roErrMsg}`,
      );
      return { indexed: 0, skipped: 0, roData: null };
     }
    }));

    const results = await Promise.all(roPromises);
    jobsIndexed += results.reduce((a, b) => a + b.indexed, 0);
    skippedUnchanged += results.reduce((a, b) => a + b.skipped, 0);
    
    for (const r of results) {
      if (r.roData) {
        rosForNormalized.push(r.roData);
      }
    }

    page++;
    // Page completed → heartbeat the drain watchdog (no-op under the cron path).
    onPageProgress?.();
    await new Promise(r => setTimeout(r, 200));
  }

  // Dual-write to normalized collections
  let normalizedCount = 0;
  try {
    const normalizedResult = await ingestionService.ingestWorkOrderBatchWithAllEntities(rosForNormalized);
    normalizedCount = normalizedResult.workOrders.created + normalizedResult.workOrders.updated;
    console.log(`[Tekmetric Backfill] Shop ${shopId}: Normalized ${normalizedCount} WOs (${normalizedResult.workOrders.created} new), payments: ${normalizedResult.payments.created}, inspections: ${normalizedResult.inspections.created}, recs: ${normalizedResult.recommendations.created}`);
  } catch (normalizedError) {
    console.error(`[Tekmetric Backfill] Shop ${shopId}: Normalized ingestion error:`, normalizedError);
  }

  // Decide cursor advancement strategy:
  //  - On error: do NOT advance; next run retries the same window.
  //    EXCEPT: if this same chunk window has now errored
  //    MAX_CONSECUTIVE_CHUNK_ERRORS times in a row, force-skip past it
  //    so one persistently bad window can't freeze the cursor forever
  //    (auto-clear of `lastError` was insufficient: it just resets the
  //    timestamp, the next attempt re-errors, repeat).
  //  - On hitting the page cap: only advance halfway, leaving the older half for the next run.
  //  - Otherwise: advance fully to the chunk start.
  const priorConsecutiveErrors = (progress?.consecutiveChunkErrors as number) || 0;
  const cursorIsSameWindow =
    !!progress?.currentChunkEnd &&
    new Date(progress.currentChunkEnd).getTime() === chunkEnd.getTime();
  // Combined error flag kept for metrics + the return payload; the advance
  // decision itself distinguishes window-level vs per-record failures.
  const chunkHadError = chunkHadWindowError || chunkHadRecordError;
  // The 429 accumulator is already live on `chunkBackoffCounter` by the time we
  // reach the advance decision; a chunk that failed while paying meaningful
  // backoff is a throttling failure, not bad data.
  const chunkBackoffSoFarMs = chunkBackoffCounter?.ms || 0;

  // All the cursor-advance policy (rate-limit SHRINK, bad-data NARROW/HOLD/
  // FORCE_SKIP, per-RO RECORD_SKIP, page-cap SPLIT, FULL) lives in a pure,
  // unit-tested helper. The key contract it enforces: a single bad RO
  // (chunkHadRecordError) can NEVER hold or force-skip the whole window, and a
  // genuine window read failure (chunkHadWindowError) bisects to isolate the
  // corrupt slice before force-skipping only that minimal slice.
  const advance = decideChunkAdvance(
    {
      chunkHadWindowError,
      chunkHadRecordError,
      chunkBackoffMs: chunkBackoffSoFarMs,
      hitPageCap,
      cursorIsSameWindow,
      priorConsecutiveErrors,
      effectiveChunkDays,
      chunkDaysOverride,
    },
    {
      maxConsecutiveChunkErrors: MAX_CONSECUTIVE_CHUNK_ERRORS,
      rateLimitShrinkBackoffMs: RATE_LIMIT_SHRINK_BACKOFF_MS,
      minChunkDaysOnRateLimit: MIN_CHUNK_DAYS_ON_ERROR,
      minChunkDaysOnBadData: MIN_CHUNK_DAYS_ON_BAD_DATA,
    },
  );

  const errorWasRateLimited = advance.errorWasRateLimited;
  const incrementedConsecutiveErrors = advance.incrementedConsecutiveErrors;
  const forceSkipBadWindow = advance.forceSkipBadWindow;
  // Persisted counter (reset to 0 on force-skip / narrowing / clean advance).
  const nextConsecutiveErrors = advance.nextConsecutiveErrors;
  const nextChunkDaysOverride: number | null = advance.nextChunkDaysOverride;

  // Map the abstract cursorAction onto concrete dates. hold=same window,
  // full/skip=advance to the (possibly narrowed) chunk start, split=midpoint.
  let nextChunkEnd: Date;
  switch (advance.cursorAction) {
    case "hold":
      nextChunkEnd = chunkEnd;
      break;
    case "split":
      nextChunkEnd = midpoint(chunkStart, chunkEnd);
      break;
    case "skip":
    case "full":
    default:
      nextChunkEnd = chunkStart;
      break;
  }

  const windowStr = `${chunkStart.toISOString().split("T")[0]}..${chunkEnd.toISOString().split("T")[0]}`;
  let advanceMode: string;
  switch (advance.kind) {
    case "SHRINK":
      advanceMode = `SHRINK (rate-limited, chunkDays ${effectiveChunkDays}→${nextChunkDaysOverride}, backoff429=${Math.round(chunkBackoffSoFarMs)}ms)`;
      console.warn(
        `[Tekmetric Backfill] SHRINK shop=${shopId} window=${windowStr} chunkDays ${effectiveChunkDays}->${nextChunkDaysOverride} backoff429=${Math.round(chunkBackoffSoFarMs)}ms`,
      );
      break;
    case "NARROW":
      advanceMode = `NARROW (window read error, bisecting to isolate bad data, chunkDays ${effectiveChunkDays}→${nextChunkDaysOverride})`;
      console.warn(
        `[Tekmetric Backfill] NARROW shop=${shopId} window=${windowStr} chunkDays ${effectiveChunkDays}->${nextChunkDaysOverride} (isolating bad data)`,
      );
      break;
    case "HOLD":
      advanceMode = `HOLD (window read error at min span, ${incrementedConsecutiveErrors}/${MAX_CONSECUTIVE_CHUNK_ERRORS})`;
      break;
    case "FORCE_SKIP":
      advanceMode = `FORCE_SKIP (narrowed window errored ${incrementedConsecutiveErrors}x in a row, skipping ${effectiveChunkDays}d slice ${windowStr})`;
      console.warn(
        `[Tekmetric Backfill] FORCE_SKIP shop=${shopId} window=${windowStr} spanDays=${effectiveChunkDays} consecutiveErrors=${incrementedConsecutiveErrors}`,
      );
      break;
    case "RECORD_SKIP":
      advanceMode = `RECORD_SKIP (${perRoExceptions} RO(s) failed, rest of window ingested, advancing normally)`;
      break;
    case "SPLIT":
      advanceMode = `SPLIT (page cap hit, advancing only to ${nextChunkEnd.toISOString().split("T")[0]})`;
      break;
    case "FULL":
    default:
      advanceMode = "FULL";
      break;
  }
  // Completion requires the cursor to actually move forward (full advance or a
  // force-skip of the final narrow slice) all the way to the oldest date. A
  // held window (SHRINK/NARROW/HOLD) or a page-cap SPLIT is never complete.
  // Per-RO record errors advance FULL, so a lone bad RO no longer blocks
  // completion — the good data ingested and the bad RO is recorded.
  let isComplete =
    (advance.cursorAction === "full" || advance.cursorAction === "skip") &&
    nextChunkEnd <= oldestDate;
  // Coverage probe: before declaring victory, ask Tekmetric how many ROs
  // it actually has for this shop with no date filter. If we've indexed
  // dramatically fewer than that AND the shop is large enough that low
  // coverage isn't just startup noise, refuse to mark complete and flag
  // the shop for full-page reindex instead. This is the safety net for
  // bulk-migrated shops (Casey/Duxler/etc) whose ROs all share recent
  // updatedDates — the date-window chunker can't see the rest of their
  // history and will otherwise fall-positive complete with <2% indexed.
  let coverageCheck: any = null;
  let downgradeToFullPage = false;
  if (isComplete) {
    const totalAvailable = await probeTekmetricRoCount(shopId, tekmetricShopId);
    // CRITICAL: use indexed RO count, NOT job count. `totalAvailable` from
    // Tekmetric is `/repair-orders` totalElements (ROs). `totalJobsIndexed`
    // counts service-line jobs which routinely outnumber ROs 2–5x — using
    // the wrong unit would let bulk-migrated shops slip through with a
    // false ratio > 1.0. We count canonical ROs from `normalized_work_orders`
    // which is the dual-write target for the chunker (see ingestionService
    // .ingestWorkOrderBatchWithAllEntities). countDocuments uses the
    // shopId index (see scripts/ensure-indexes.ts).
    let totalIndexedRos = 0;
    try {
      totalIndexedRos = await db.collection("normalized_work_orders").countDocuments({ shopId });
    } catch (countErr: any) {
      console.warn(`[Tekmetric Backfill] Shop ${shopId}: coverage probe count failed:`, countErr?.message || countErr);
    }
    if (
      totalAvailable !== null &&
      totalAvailable > COVERAGE_PROBE_MIN_TOTAL &&
      totalIndexedRos / totalAvailable < COVERAGE_MIN_RATIO
    ) {
      coverageCheck = {
        totalElementsAvailable: totalAvailable,
        totalRosIndexed: totalIndexedRos,
        ratio: Number((totalIndexedRos / totalAvailable).toFixed(4)),
        checkedAt: new Date(),
        triggeredAutoFlag: true,
      };
      downgradeToFullPage = true;
      isComplete = false;
      console.warn(
        `[Tekmetric Backfill] Shop ${shopId}: COVERAGE LOW — Tekmetric reports ${totalAvailable} ROs but only ${totalIndexedRos} ROs indexed (${(totalIndexedRos / totalAvailable * 100).toFixed(1)}%). Auto-flagging for full-page reindex.`,
      );
    } else if (totalAvailable !== null) {
      coverageCheck = {
        totalElementsAvailable: totalAvailable,
        totalRosIndexed: totalIndexedRos,
        ratio: Number((totalIndexedRos / Math.max(1, totalAvailable)).toFixed(4)),
        checkedAt: new Date(),
        triggeredAutoFlag: false,
      };
    }
  }
  // Track actual cursor movement so the sync-health endpoint can report a
  // truthful "frozen for N days" — relying on lastRunAt/lastErrorAt
  // underreports duration for shops that run every night but never advance
  // (recurring-error case).
  const cursorMoved = nextChunkEnd.getTime() !== chunkEnd.getTime();
  const now = new Date();

  console.log(`[Tekmetric Backfill] Shop ${shopId}: cursor advance ${advanceMode}`);

  if (perRoExceptions > 0) {
    const sampleIds = skippedRoSamples.map(s => s.roId).slice(0, 10).join(",");
    console.warn(
      `[Tekmetric Backfill] Shop ${shopId}: ${perRoExceptions} RO(s) threw and were skipped this chunk (sample: ${sampleIds})`,
    );
  }

  // Track consecutive runs that skipped at least one RO. This is what the
  // sync-health endpoint pages on: a single bad chunk happens, but if the
  // SAME shop drops ROs run after run, that's silent data loss.
  const priorConsecutiveRoSkipRuns = (progress?.consecutiveRoSkipRuns as number) || 0;
  const nextConsecutiveRoSkipRuns = perRoExceptions > 0 ? priorConsecutiveRoSkipRuns + 1 : 0;
  // Maintain a rolling sample of recently skipped ROs across runs (capped),
  // newest first, deduped by roId so a chronically-bad RO doesn't push every
  // other id out of the window.
  const priorRecent: { roId: number; error: string; at: Date | string }[] =
    Array.isArray(progress?.recentSkippedRos) ? progress.recentSkippedRos : [];

  // Auto-resolve previously-skipped ROs that we successfully re-fetched this
  // run. We only resolve entries that were NOT freshly skipped this same run
  // (a fresh skip wins over a same-run resolve — if the RO is bouncing, keep
  // it visible). Resolved entries are archived into
  // `tekmetric_skipped_ro_archive` for postmortems and removed from the
  // rolling window so the admin sync-health view stops showing stale ids
  // forever after a transient burst recovers.
  const freshlySkippedIds = new Set<number>(skippedRoSamples.map(s => s.roId));
  const resolvedEntries: { roId: number; error: string; at: Date | string }[] = [];
  const remainingPriorRecent: typeof priorRecent = [];
  for (const entry of priorRecent) {
    if (reFetchedRoIds.has(entry.roId) && !freshlySkippedIds.has(entry.roId)) {
      resolvedEntries.push(entry);
    } else {
      remainingPriorRecent.push(entry);
    }
  }

  // Only clear entries from `recentSkippedRos` AFTER the archive write
  // succeeds — otherwise a Mongo blip would silently destroy the postmortem
  // record. On archive failure, leave the entries on the live list so they
  // can be retried on the next run.
  let archivedResolvedCount = 0;
  if (resolvedEntries.length > 0) {
    try {
      const archiveResult = await archiveResolvedSkippedRos(
        db,
        shopId,
        resolvedEntries,
        { mode: "auto", resolvedInChunk: { start: chunkStart, end: chunkEnd } },
        now,
      );
      archivedResolvedCount = archiveResult.archivedCount;
      console.log(
        `[Tekmetric Backfill] Shop ${shopId}: archived ${resolvedEntries.length} recovered RO(s) (ids: ${resolvedEntries.map(r => r.roId).join(",")})`,
      );
    } catch (archiveErr: any) {
      // Roll back the resolution: put resolved entries back on the rolling
      // window so the next run will retry archiving. Postmortem fidelity wins
      // over admin-view tidiness here.
      remainingPriorRecent.push(...resolvedEntries);
      console.warn(
        `[Tekmetric Backfill] Shop ${shopId}: failed to archive ${resolvedEntries.length} resolved RO(s); keeping on recentSkippedRos for retry: ${archiveErr?.message || archiveErr}`,
      );
    }
  }

  // Recompute the rolling window from (fresh skips this run) ∪ (prior entries
  // not resolved this run), capped at 25 newest-first deduped by roId.
  let nextRecentSkippedRos = remainingPriorRecent;
  if (skippedRoSamples.length > 0 || archivedResolvedCount > 0) {
    const seenIds = new Set<number>();
    nextRecentSkippedRos = [];
    for (const s of [...skippedRoSamples, ...remainingPriorRecent]) {
      if (seenIds.has(s.roId)) continue;
      seenIds.add(s.roId);
      nextRecentSkippedRos.push(s);
      if (nextRecentSkippedRos.length >= 25) break;
    }
  }

  // Emit a structured warning if the prior cursor-move timestamp is older
  // than STUCK_CURSOR_DAYS and we're STILL not moving the cursor this run.
  // This makes recurring-error stalls visible in the cron logs without
  // requiring anyone to query Mongo.
  if (!cursorMoved && progress?.lastCursorMoveAt) {
    const daysSinceMove = (now.getTime() - new Date(progress.lastCursorMoveAt).getTime()) / (24 * 60 * 60 * 1000);
    if (daysSinceMove > STUCK_CURSOR_DAYS) {
      console.warn(
        `[Tekmetric Backfill] STUCK shop=${shopId} cursorFrozenDays=${daysSinceMove.toFixed(1)} ` +
        `currentChunkEnd=${chunkEnd.toISOString().split("T")[0]} mode=${advanceMode}`
      );
    }
  }

  // Compute per-chunk speed metrics. The 429 backoff value is sourced from
  // a per-chunk AsyncLocalStorage counter (`chunkBackoffCounter.ms`), which
  // accumulates only the 429 waits paid by this chunk's own Tekmetric
  // requests — concurrent chunks (same process, different shop) get
  // independent counters so one shop's rate-limit waits cannot leak into
  // this chunk's metric.
  const chunkDurationMs = Date.now() - chunkStartedAt;
  const chunkBackoffMs = chunkBackoffCounter.ms;
  const jobsCacheTotal = jobsCacheHits + jobsCacheMisses;
  const vehiclesCacheTotal = vehiclesCacheHits + vehiclesCacheMisses;
  const customersCacheTotal = customersCacheHits + customersCacheMisses;
  const chunkMetrics = {
    at: now,
    durationMs: chunkDurationMs,
    roCount: seenROIds.size,
    chunkStart,
    chunkEnd,
    nextChunkEnd,
    advanceMode,
    jobsCacheHits,
    jobsCacheMisses,
    jobsCacheHitRate: jobsCacheTotal > 0
      ? Number((jobsCacheHits / jobsCacheTotal).toFixed(4))
      : null,
    vehiclesCacheHits,
    vehiclesCacheMisses,
    vehiclesCacheHitRate: vehiclesCacheTotal > 0
      ? Number((vehiclesCacheHits / vehiclesCacheTotal).toFixed(4))
      : null,
    customersCacheHits,
    customersCacheMisses,
    customersCacheHitRate: customersCacheTotal > 0
      ? Number((customersCacheHits / customersCacheTotal).toFixed(4))
      : null,
    vehiclesPrePassDoneForShop,
    vehiclesPrePassHits,
    vehiclesPrePassMisses,
    customersPrePassDoneForShop,
    customersPrePassHits,
    customersPrePassMisses,
    backoff429Ms: Math.round(chunkBackoffMs),
    chunkHadError,
    hitPageCap,
    perRoExceptions,
    // Bulk shop-level /jobs pre-pass metrics (task #146). Recorded
    // per-chunk so on-call can confirm in the admin sync-health view
    // that the bulk path is actually running and saving API calls
    // (vs. silently falling back to per-RO calls). `bulkJobsErrored`
    // surfaces a bulk fetch that threw — the chunk still completed
    // via the per-RO fallback, but the metric is the signal.
    // `bulkJobsEnabledForShop` distinguishes "bulk turned off because
    // this is a legacy shop without the per-shop opt-in" from "bulk
    // tried and failed".
    bulkJobsEnabledForShop,
    bulkJobsPagesFetched,
    bulkJobsRosSeeded,
    bulkJobsTotal,
    bulkJobsApiCallsSaved,
    bulkJobsCapped,
    bulkJobsErrored,
  };
  // Cap the rolling window newest-first. We DO want to see slow chunks even
  // when the shop also drops ROs that run, so don't condition writes on
  // success — the metric is per-chunk health, not per-RO health.
  const priorChunkMetrics: any[] = Array.isArray(progress?.recentChunkMetrics)
    ? progress.recentChunkMetrics
    : [];
  const nextRecentChunkMetrics = [chunkMetrics, ...priorChunkMetrics].slice(
    0,
    RECENT_CHUNK_METRICS_LIMIT,
  );

  console.log(
    `[Tekmetric Backfill] Shop ${shopId}: chunk metrics ` +
      `duration=${chunkDurationMs}ms ros=${seenROIds.size} ` +
      `jobsCache=${jobsCacheHits}/${jobsCacheTotal} ` +
      `vehiclesCache=${vehiclesCacheHits}/${vehiclesCacheTotal} ` +
      `vehiclesPrePass=${vehiclesPrePassDoneForShop ? `${vehiclesPrePassHits}/${vehiclesPrePassHits + vehiclesPrePassMisses}` : "off"} ` +
      `customersCache=${customersCacheHits}/${customersCacheTotal} ` +
      `customersPrePass=${customersPrePassDoneForShop ? `${customersPrePassHits}/${customersPrePassHits + customersPrePassMisses}` : "off"} ` +
      `429backoff=${Math.round(chunkBackoffMs)}ms`,
  );

  await updateProgressFields(
    shopId,
    {
      currentChunkEnd: nextChunkEnd,
        lastRunAt: now,
        completed: isComplete,
        ...(isComplete ? { completedAt: now } : {}),
        ...(cursorMoved
          ? { lastCursorMoveAt: now, previousChunkEnd: chunkEnd }
          : {}),
        consecutiveChunkErrors: nextConsecutiveErrors,
        nextChunkDaysOverride: nextChunkDaysOverride,
        lastRoSkipCount: perRoExceptions,
        ...(perRoExceptions > 0 ? { lastRoSkipAt: now } : {}),
        consecutiveRoSkipRuns: nextConsecutiveRoSkipRuns,
        recentSkippedRos: nextRecentSkippedRos,
        ...(archivedResolvedCount > 0 ? { lastSkippedRosResolvedAt: now } : {}),
        // A shop is "fully recovered" the moment consecutiveRoSkipRuns drops
        // back to 0 AND the rolling window is empty (every prior id has been
        // confirmed re-fetched). Stamp it so the admin view can label the
        // shop as recovered rather than just hide it.
        ...(nextConsecutiveRoSkipRuns === 0 && nextRecentSkippedRos.length === 0 && (priorRecent.length > 0 || (priorConsecutiveRoSkipRuns > 0))
          ? { roSkipsFullyRecoveredAt: now }
          : {}),
        lastChunkMetrics: chunkMetrics,
        recentChunkMetrics: nextRecentChunkMetrics,
        ...(coverageCheck ? { lastCoverageCheck: coverageCheck } : {}),
        ...(downgradeToFullPage
          ? {
              needsFullPageReindex: true,
              fullPageMode: true,
              fullPageNextPage: 0,
              fullPageQueuedAt: now,
              fullPageQueueReason: `auto-flagged by coverage probe: ${coverageCheck?.totalRosIndexed}/${coverageCheck?.totalElementsAvailable} ROs (${((coverageCheck?.ratio ?? 0) * 100).toFixed(1)}%)`,
            }
          : {}),
        // lastError is keyed off the advance KIND, not the raw error flag, so a
        // RECORD_SKIP (single bad RO, rest of window ingested) does NOT flag the
        // shop red — the bad RO is surfaced via lastRoSkipCount / recentSkippedRos
        // instead. Only genuine window read failures set lastError.
        ...(advance.kind === "SHRINK" || advance.kind === "RECORD_SKIP" || advance.kind === "SPLIT" || advance.kind === "FULL"
          ? { lastError: null, lastErrorAt: null }
          : advance.kind === "NARROW"
          ? { lastError: `window read error, narrowing to isolate bad data (chunkDays ${effectiveChunkDays}→${nextChunkDaysOverride})`, lastErrorAt: now }
          : advance.kind === "HOLD"
          ? { lastError: `window read error at min span, holding cursor (${incrementedConsecutiveErrors}/${MAX_CONSECUTIVE_CHUNK_ERRORS})`, lastErrorAt: now }
          : advance.kind === "FORCE_SKIP"
          ? {
              lastError: `force-skipped narrowed ${effectiveChunkDays}d slice after ${incrementedConsecutiveErrors} consecutive window read failures`,
              lastErrorAt: now,
              lastForceSkippedWindow: { start: chunkStart, end: chunkEnd, spanDays: effectiveChunkDays, at: now },
            }
          : { lastError: null, lastErrorAt: null }),
    },
    {
      incFields: {
        totalJobsIndexed: jobsIndexed,
        ...(archivedResolvedCount > 0 ? { resolvedSkippedRosTotal: archivedResolvedCount } : {}),
      },
    },
  );

  // Set shop-level completion flag when backfill is done
  if (isComplete) {
    await db.collection("shops").updateOne(
      { shopId },
      { $set: { tekmetricBackfillComplete: true, tekmetricBackfillCompletedAt: new Date() } }
    );
    console.log(`[Tekmetric Backfill] Shop ${shopId}: Marked tekmetricBackfillComplete=true`);
  }

  _metricRos = seenROIds.size;
  _metricBackoffMs = Math.round(chunkBackoffMs);
  _metricOutcome = chunkHadError ? "error" : isComplete ? "complete" : "ok";
  return {
    jobsIndexed,
    skipped: skippedUnchanged,
    complete: isComplete,
    message: `${startStr.split("T")[0]} to ${endStr.split("T")[0]}: ${jobsIndexed} jobs indexed, ${skippedUnchanged} unchanged, ${normalizedCount} normalized`,
    normalizedCount
  };
  });
  } catch (err) {
    _metricOutcome = "error";
    throw err;
  } finally {
    await recordChunkMetric({
      provider: "tekmetric",
      shopId,
      chunkStartedAt: _metricStartedAt,
      rosProcessed: _metricRos,
      outcome: _metricOutcome,
      backoffMs: _metricBackoffMs,
      counters: chunkWriteCounters,
    });
  }
  });
}

// Roster sync (Task #632). Iterate ALL connected Tekmetric shops (NOT just the
// backfill queue), pick the stalest ones whose last roster sync is older than
// ROSTER_SYNC_STALE_HOURS, and refresh their upcoming appointments + current
// employee roster into the normalized PG layer. Bounded per tick and run with
// limited parallelism so it stays light next to backfill. Every shop is
// wrapped so one failure never sinks the pass.
async function runRosterSyncPass(
  db: any,
): Promise<{ attempted: number; synced: number; errors: number }> {
  const staleBefore = new Date(
    Date.now() - ROSTER_SYNC_STALE_HOURS * 60 * 60 * 1000,
  );

  // Connected Tekmetric shops store the Tekmetric shop id either under
  // `tekmetric.shopId` (current) or the legacy top-level `tekmetricShopId`.
  const shops: any[] = await db
    .collection("shops")
    .find(
      {
        $or: [
          { "tekmetric.shopId": { $exists: true, $ne: null } },
          { tekmetricShopId: { $exists: true, $ne: null } },
        ],
      },
      { projection: { shopId: 1, tekmetric: 1, tekmetricShopId: 1, enterpriseId: 1 } },
    )
    .toArray();

  if (shops.length === 0) return { attempted: 0, synced: 0, errors: 0 };

  // Pull the last-sync bookkeeping for these shops in one query, then pick the
  // stalest shops first (never-synced shops sort earliest via epoch 0).
  const bookkeeping: any[] = await db
    .collection(ROSTER_SYNC_COLLECTION)
    .find({}, { projection: { shopId: 1, lastRosterSyncAt: 1 } })
    .toArray();
  const lastSyncByShop = new Map<number, number>();
  for (const b of bookkeeping) {
    const t =
      b?.lastRosterSyncAt instanceof Date
        ? b.lastRosterSyncAt.getTime()
        : b?.lastRosterSyncAt
          ? new Date(b.lastRosterSyncAt).getTime()
          : 0;
    lastSyncByShop.set(Number(b.shopId), Number.isFinite(t) ? t : 0);
  }

  const candidates = shops
    .map((s) => {
      const tekmetricShopId = Number(s.tekmetric?.shopId ?? s.tekmetricShopId);
      return {
        shopId: Number(s.shopId),
        tekmetricShopId,
        enterpriseId: s.enterpriseId ? String(s.enterpriseId) : null,
        lastSyncMs: lastSyncByShop.get(Number(s.shopId)) ?? 0,
      };
    })
    .filter(
      (s) =>
        Number.isFinite(s.shopId) &&
        Number.isFinite(s.tekmetricShopId) &&
        s.lastSyncMs < staleBefore.getTime(),
    )
    .sort((a, b) => a.lastSyncMs - b.lastSyncMs)
    .slice(0, ROSTER_SYNC_MAX_SHOPS_PER_RUN);

  if (candidates.length === 0) return { attempted: 0, synced: 0, errors: 0 };

  const limit = pLimit(ROSTER_SYNC_PARALLELISM);
  let synced = 0;
  let errors = 0;

  await Promise.all(
    candidates.map((shop) =>
      limit(async () => {
        try {
          const result = await syncTekmetricRoster(
            shop.shopId,
            shop.tekmetricShopId,
            shop.enterpriseId,
          );
          if (result.errors.length > 0) {
            errors++;
            console.warn(
              `[Roster Sync] Shop ${shop.shopId} partial errors: ${result.errors.join("; ")}`,
            );
          } else {
            synced++;
          }
          // Always record the attempt so a persistently failing shop doesn't
          // monopolize the staleness queue every tick; it still retries next
          // window. Stamp regardless of partial errors.
          await db
            .collection(ROSTER_SYNC_COLLECTION)
            .updateOne(
              { shopId: shop.shopId },
              {
                $set: {
                  shopId: shop.shopId,
                  lastRosterSyncAt: new Date(),
                  lastResult: {
                    appointments: result.appointments,
                    employees: result.employees,
                    errors: result.errors,
                  },
                },
              },
              { upsert: true },
            );
        } catch (err: any) {
          errors++;
          console.error(
            `[Roster Sync] Shop ${shop.shopId} failed:`,
            err?.message || err,
          );
          // Stamp the attempt even on hard failure so it rotates out of the
          // queue head and retries on the next staleness window.
          try {
            await db
              .collection(ROSTER_SYNC_COLLECTION)
              .updateOne(
                { shopId: shop.shopId },
                {
                  $set: {
                    shopId: shop.shopId,
                    lastRosterSyncAt: new Date(),
                    lastError: (err?.message || String(err)).slice(0, 500),
                  },
                },
                { upsert: true },
              );
          } catch {
            /* bookkeeping write is best-effort */
          }
        }
      }),
    ),
  );

  console.log(
    `[Roster Sync] Attempted ${candidates.length} shop(s): ${synced} ok, ${errors} with errors.`,
  );
  return { attempted: candidates.length, synced, errors };
}

// Protractor roster sync (Task #635). Mirrors runRosterSyncPass but iterates
// connected Protractor shops, picking the stalest whose last roster sync is
// older than PROTRACTOR_ROSTER_SYNC_STALE_HOURS, and refreshes their upcoming
// appointments + current employee roster into the same normalized PG tables.
// Bounded per tick and run with limited parallelism so it stays light next to
// backfill. Every shop is wrapped so one failure never sinks the pass.
async function runProtractorRosterSyncPass(
  db: any,
): Promise<{ attempted: number; synced: number; errors: number }> {
  const staleBefore = new Date(
    Date.now() - PROTRACTOR_ROSTER_SYNC_STALE_HOURS * 60 * 60 * 1000,
  );

  // Connected Protractor shops store config under `protractor.*` (current) or
  // the legacy top-level `protractor{ConnectionId,ApiKey}` fields.
  const shops: any[] = await db
    .collection("shops")
    .find(
      {
        $or: [
          { "protractor.connectionId": { $exists: true, $ne: null } },
          { "protractor.apiKey": { $exists: true, $ne: null } },
          { "protractor.configured": true },
          { protractorConnectionId: { $exists: true, $ne: null } },
          { protractorApiKey: { $exists: true, $ne: null } },
        ],
      },
      { projection: { shopId: 1, enterpriseId: 1 } },
    )
    .toArray();

  if (shops.length === 0) return { attempted: 0, synced: 0, errors: 0 };

  const bookkeeping: any[] = await db
    .collection(PROTRACTOR_ROSTER_SYNC_COLLECTION)
    .find({}, { projection: { shopId: 1, lastRosterSyncAt: 1 } })
    .toArray();
  const lastSyncByShop = new Map<number, number>();
  for (const b of bookkeeping) {
    const t =
      b?.lastRosterSyncAt instanceof Date
        ? b.lastRosterSyncAt.getTime()
        : b?.lastRosterSyncAt
          ? new Date(b.lastRosterSyncAt).getTime()
          : 0;
    lastSyncByShop.set(Number(b.shopId), Number.isFinite(t) ? t : 0);
  }

  const candidates = shops
    .map((s) => ({
      shopId: Number(s.shopId),
      enterpriseId: s.enterpriseId ? String(s.enterpriseId) : null,
      lastSyncMs: lastSyncByShop.get(Number(s.shopId)) ?? 0,
    }))
    .filter(
      (s) => Number.isFinite(s.shopId) && s.lastSyncMs < staleBefore.getTime(),
    )
    .sort((a, b) => a.lastSyncMs - b.lastSyncMs)
    .slice(0, PROTRACTOR_ROSTER_SYNC_MAX_SHOPS_PER_RUN);

  if (candidates.length === 0) return { attempted: 0, synced: 0, errors: 0 };

  const limit = pLimit(PROTRACTOR_ROSTER_SYNC_PARALLELISM);
  let synced = 0;
  let errors = 0;

  await Promise.all(
    candidates.map((shop) =>
      limit(async () => {
        try {
          const result = await syncProtractorRoster(
            shop.shopId,
            shop.enterpriseId,
          );
          if (result.errors.length > 0) {
            errors++;
            console.warn(
              `[Protractor Roster Sync] Shop ${shop.shopId} partial errors: ${result.errors.join("; ")}`,
            );
          } else {
            synced++;
          }
          await db
            .collection(PROTRACTOR_ROSTER_SYNC_COLLECTION)
            .updateOne(
              { shopId: shop.shopId },
              {
                $set: {
                  shopId: shop.shopId,
                  lastRosterSyncAt: new Date(),
                  lastResult: {
                    appointments: result.appointments,
                    employees: result.employees,
                    errors: result.errors,
                  },
                },
              },
              { upsert: true },
            );
        } catch (err: any) {
          errors++;
          console.error(
            `[Protractor Roster Sync] Shop ${shop.shopId} failed:`,
            err?.message || err,
          );
          try {
            await db
              .collection(PROTRACTOR_ROSTER_SYNC_COLLECTION)
              .updateOne(
                { shopId: shop.shopId },
                {
                  $set: {
                    shopId: shop.shopId,
                    lastRosterSyncAt: new Date(),
                    lastError: (err?.message || String(err)).slice(0, 500),
                  },
                },
                { upsert: true },
              );
          } catch {
            /* bookkeeping write is best-effort */
          }
        }
      }),
    ),
  );

  console.log(
    `[Protractor Roster Sync] Attempted ${candidates.length} shop(s): ${synced} ok, ${errors} with errors.`,
  );
  return { attempted: candidates.length, synced, errors };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.TEKMETRIC_CLIENT_ID || !process.env.TEKMETRIC_CLIENT_SECRET) {
    return NextResponse.json({ error: "Tekmetric OAuth credentials not configured" }, { status: 500 });
  }

  const db = await getDb();

  // Drain-mode lock: when scripts/drain-tekmetric-backfill.ts is running
  // it holds an exclusive lease on the backfill so its in-process chunk
  // calls don't race the cron's writes to `tekmetric_backfill_progress`
  // (cursor regressions, clobbered skip windows, double-counted totals).
  // Lease has a TTL — a crashed drain won't lock cron out forever.
  const drainLock = await getDrainLock();
  if (drainLock && drainLock.expiresAt && new Date(drainLock.expiresAt) > new Date()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "drain_in_progress",
      drainLock: {
        owner: drainLock.owner || "unknown",
        acquiredAt: drainLock.acquiredAt,
        expiresAt: drainLock.expiresAt,
      },
      message: "Tekmetric backfill drain worker holds an exclusive lease; this cron tick is a no-op.",
    });
  }

  const startTime = Date.now();

  // Wrap the whole backfill cycle in an AsyncLocalStorage scope so the
  // API-call count we report is *this* run's calls only — not leaked
  // from any other concurrent Tekmetric operation in the same Node
  // process (e.g. an admin-clicked RO retry running in parallel).
  // Mirrors the per-chunk 429 tracking pattern already in place.
  return runWithTekmetricApiCallTracking(async (apiCallCounter) => {
  try {
    // Run the stale-skipped-RO sweep BEFORE shop processing so the same run
    // both archives cold entries and processes new chunks. Wrapped so a
    // sweep failure can never block the actual backfill work.
    let staleSweep = { shopsTouched: 0, entriesArchived: 0 };
    try {
      staleSweep = await sweepStaleSkippedRos(db);
    } catch (sweepErr: any) {
      console.warn(
        `[Tekmetric Backfill] Stale sweep threw; continuing with backfill: ${sweepErr?.message || sweepErr}`,
      );
    }

    // Roster sync pass (Task #632): refresh upcoming appointments + current
    // employee roster for connected Tekmetric shops. Placed BEFORE the
    // "no shops need backfill" early-return below so it keeps running once
    // backfill is complete (the steady state). Fully wrapped so a roster
    // failure can never block backfill, and bounded/staleness-gated so it
    // stays lightweight.
    let rosterSync: {
      attempted: number;
      synced: number;
      errors: number;
    } = { attempted: 0, synced: 0, errors: 0 };
    try {
      rosterSync = await runRosterSyncPass(db);
    } catch (rosterErr: any) {
      console.warn(
        `[Tekmetric Backfill] Roster sync pass threw; continuing with backfill: ${rosterErr?.message || rosterErr}`,
      );
    }

    // Protractor roster sync pass (Task #635): same lightweight, staleness-gated
    // refresh of upcoming appointments + current employee roster, but for
    // connected Protractor shops. Fully wrapped so a Protractor roster failure
    // can never block the Tekmetric backfill.
    let protractorRosterSync: {
      attempted: number;
      synced: number;
      errors: number;
    } = { attempted: 0, synced: 0, errors: 0 };
    try {
      protractorRosterSync = await runProtractorRosterSyncPass(db);
    } catch (rosterErr: any) {
      console.warn(
        `[Tekmetric Backfill] Protractor roster sync pass threw; continuing with backfill: ${rosterErr?.message || rosterErr}`,
      );
    }

    // Fastpath mode: when invoked as `?fastpath=newShops` (the
    // every-5-min cron), restrict the queue to shops created in the
    // last NEW_SHOP_FASTPATH_DAYS days so freshly onboarded clients
    // see their data populate quickly without waiting for the normal
    // queue rotation.
    const url = new URL(req.url);
    const fastpath = url.searchParams.get("fastpath");
    const isFastpath = fastpath === "newShops";
    const effectiveMaxShops = isFastpath
      ? FASTPATH_MAX_SHOPS_PER_RUN
      : MAX_SHOPS_PER_RUN;

    let shopsToProcess = await getShopsNeedingBackfill(db);

    if (isFastpath) {
      const cutoff = new Date(
        Date.now() - NEW_SHOP_FASTPATH_DAYS * 24 * 60 * 60 * 1000,
      );
      const newShopIds = new Set<number>(
        (
          await db
            .collection("shops")
            .find(
              { createdAt: { $gte: cutoff } },
              { projection: { shopId: 1 } },
            )
            .toArray()
        ).map((s: any) => Number(s.shopId)),
      );
      shopsToProcess = shopsToProcess.filter((s) =>
        newShopIds.has(Number(s.shopId)),
      );

      // Idempotence guard (task #966): a fastpath tick used to re-pick
      // the exact same shops even while the previous tick's chunks were
      // still running (or had just run), so a slow shop turned every
      // 5-min tick into another parallel/duplicate kick until the
      // scheduler timed the route out at 480s. Skip shops that are
      // demonstrably already being worked:
      //   - in_flight: the per-shop in-flight lock is live with a fresh
      //     heartbeat (another process is actively chunking this shop);
      //   - recently_attempted: lastRunAt is within the fastpath cadence,
      //     so the previous tick already made progress — the next tick
      //     will pick it up again once the cooldown lapses.
      // Each skip logs a clear reason so on-call can confirm the guard
      // is doing the throttling instead of a silent timeout loop.
      if (shopsToProcess.length > 0) {
        const cooldownMs = FASTPATH_RECENT_ATTEMPT_MINUTES * 60 * 1000;
        const nowMs = Date.now();
        const progressRows = await listProgress(
          shopsToProcess.map((s) => Number(s.shopId)),
        );
        const progressByShop = new Map<number, any>(
          progressRows.map((r: any) => [Number(r.shopId), r]),
        );
        const kept: typeof shopsToProcess = [];
        for (const s of shopsToProcess) {
          const row = progressByShop.get(Number(s.shopId));
          const heartbeatMs = row?.inFlightHeartbeatAt
            ? new Date(row.inFlightHeartbeatAt).getTime()
            : 0;
          const lockLive =
            row?.inFlightUntil &&
            new Date(row.inFlightUntil).getTime() > nowMs &&
            heartbeatMs > nowMs - DEFAULT_STALE_HEARTBEAT_MS;
          const lastRunMs = row?.lastRunAt
            ? new Date(row.lastRunAt).getTime()
            : 0;
          if (lockLive) {
            console.log(
              `[Tekmetric Backfill] fastpath skip shop ${s.shopId}: in_flight (owner=${row.inFlightOwner || "unknown"}, heartbeat ${Math.round((nowMs - heartbeatMs) / 1000)}s ago)`,
            );
          } else if (lastRunMs > nowMs - cooldownMs) {
            console.log(
              `[Tekmetric Backfill] fastpath skip shop ${s.shopId}: recently_attempted (lastRunAt ${Math.round((nowMs - lastRunMs) / 1000)}s ago, cooldown ${FASTPATH_RECENT_ATTEMPT_MINUTES}m)`,
            );
          } else {
            kept.push(s);
          }
        }
        shopsToProcess = kept;
      }

      console.log(
        `[Tekmetric Backfill] fastpath=newShops: ${shopsToProcess.length} shop(s) eligible (created in last ${NEW_SHOP_FASTPATH_DAYS}d, after in-flight/cooldown skips)`,
      );
    }

    if (shopsToProcess.length === 0) {
      return NextResponse.json({
        ok: true,
        message: isFastpath
          ? `No new shops (created in last ${NEW_SHOP_FASTPATH_DAYS}d) need backfill`
          : "All Tekmetric shops have completed backfill",
        shopsRemaining: 0,
        staleSweep,
        rosterSync,
        protractorRosterSync,
        duration: `${Date.now() - startTime}ms`
      });
    }

    // Split slot allocation between never-started shops and stalled
    // shops with a lastRunAt. Without this split, a backlog of
    // never-started shops (sorted first by the fair-queue ordering)
    // monopolizes every slot for many runs and starves the
    // long-stalled-with-cursor bucket (the 32/36/37/54/57/73/74/75
    // group). The two buckets are interleaved per run so both make
    // progress.
    const neverStartedQueue = shopsToProcess.filter(s => !s.hasLastRunAt);
    const stalledQueue = shopsToProcess.filter(s => s.hasLastRunAt);
    const selectedNeverStarted = neverStartedQueue.slice(0, NEVER_STARTED_SLOTS_PER_RUN);
    const selectedStalled = stalledQueue.slice(0, STALLED_SLOTS_PER_RUN);
    let selectedShops = [...selectedNeverStarted, ...selectedStalled];
    // If one bucket is short (e.g. all never-started shops have already
    // moved into the stalled bucket), give the remaining slots to the
    // other bucket so we never under-utilize the budget.
    if (selectedShops.length < effectiveMaxShops) {
      const remaining = effectiveMaxShops - selectedShops.length;
      const extras = (selectedNeverStarted.length < NEVER_STARTED_SLOTS_PER_RUN
        ? stalledQueue.slice(STALLED_SLOTS_PER_RUN, STALLED_SLOTS_PER_RUN + remaining)
        : neverStartedQueue.slice(NEVER_STARTED_SLOTS_PER_RUN, NEVER_STARTED_SLOTS_PER_RUN + remaining));
      selectedShops = [...selectedShops, ...extras];
    }
    selectedShops = selectedShops.slice(0, effectiveMaxShops);

    // Smart per-shop quiet-window gate (task #662). OFF by default: when the
    // SMART_BACKFILL_TIMING flag is unset/off this does no DB read, no logging,
    // and `shopsToRun === selectedShops` — byte-for-byte the previous behavior.
    // In observe mode it logs what it *would* skip; only enforce mode drops
    // out-of-quiet-window shops. The global SHOP_PARALLELISM cap below still
    // applies regardless.
    const quietGate = await prepareQuietWindowGate(
      selectedShops.map((s) => Number(s.shopId)),
    );
    const shopsToRun =
      quietGate.mode === "off"
        ? selectedShops
        : selectedShops.filter(
            (shop) =>
              !applyQuietWindowGate(quietGate, Number(shop.shopId), "tekmetric")
                .shouldSkip,
          );

    // Process shops in parallel up to SHOP_PARALLELISM. Per-shop concurrency
    // is already throttled by the pace config and the central Tekmetric
    // client tracks the global API budget.
    const shopLimit = pLimit(SHOP_PARALLELISM);
    const results = await Promise.all(
      shopsToRun.map(shop =>
        shopLimit(async () => {
          console.log(`[Tekmetric Backfill] Processing: ${shop.name} (Shop ${shop.shopId})`);
          try {
            const result = await backfillShopChunk(db, shop.shopId, shop.tekmetricShopId);
            return { shopId: shop.shopId, name: shop.name, ...result };
          } catch (err: any) {
            console.error(`[Tekmetric Backfill] Shop ${shop.shopId} chunk failed:`, err);
            // CRITICAL: if backfillShopChunk throws (an unwrapped helper
            // like getCachedVehicle, getRepairOrderInspectionsWithXAuth,
            // or normalized ingestion blew up), the inner code never
            // reached the progress write that bumps lastRunAt. Without
            // this safety-net write, the shop keeps its old (or null)
            // lastRunAt and stays at the head of the fair-queue forever
            // — which is exactly how the 19 never-started shops were
            // monopolizing every cron slot and starving the long-stalled
            // bucket (32/36/37/...). Bump lastRunAt and record the error
            // here so the shop rotates out of the queue head and
            // ERROR_AUTO_CLEAR_HOURS can later let it retry.
            const now = new Date();
            const message = (err?.message || String(err)).slice(0, 500);
            try {
              await updateProgressFields(
                shop.shopId,
                {
                  shopId: shop.shopId,
                  lastRunAt: now,
                  lastError: `unhandled chunk exception: ${message}`,
                  lastErrorAt: now,
                },
                {
                  upsert: true,
                  setOnInsert: { startedAt: now, completed: false, logicVersion: 2 },
                },
              );
            } catch (writeErr) {
              console.error(`[Tekmetric Backfill] Shop ${shop.shopId} failed to record exception lastRunAt:`, writeErr);
            }
            return {
              shopId: shop.shopId,
              name: shop.name,
              jobsIndexed: 0,
              skipped: 0,
              complete: false,
              normalizedCount: 0,
              message: `error: ${message}`,
            };
          }
        })
      )
    );

    const apiCallCount = apiCallCounter.count;
    const duration = Date.now() - startTime;
    console.log(`[Cron] Tekmetric backfill completed in ${duration}ms — API calls made: ${apiCallCount} (budget: 600/min)`);

    return NextResponse.json({
      ok: true,
      processed: results,
      shopsRemaining: shopsToProcess.length - selectedShops.length,
      staleSweep,
      rosterSync,
      protractorRosterSync,
      duration: `${duration}ms`,
      tekmetricApiCalls: apiCallCount,
    });

  } catch (err: any) {
    const apiCallCount = apiCallCounter.count;
    console.error(`[Tekmetric Backfill] Error (API calls made: ${apiCallCount}):`, err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
  });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.TEKMETRIC_CLIENT_ID || !process.env.TEKMETRIC_CLIENT_SECRET) {
    return NextResponse.json({ error: "Tekmetric OAuth credentials not configured" }, { status: 500 });
  }

  const db = await getDb();

  // Drain-mode lock — see GET handler for rationale. Same gate applied to
  // the manual POST trigger (used by wave1-backfill.ts and admin-clicked
  // single-shop kicks) so nothing races the drain worker.
  const drainLock = await getDrainLock();
  if (drainLock && drainLock.expiresAt && new Date(drainLock.expiresAt) > new Date()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "drain_in_progress",
      drainLock: {
        owner: drainLock.owner || "unknown",
        acquiredAt: drainLock.acquiredAt,
        expiresAt: drainLock.expiresAt,
      },
      message: "Tekmetric backfill drain worker holds an exclusive lease; this manual trigger is a no-op.",
    });
  }

  const startTime = Date.now();

  // Wrap the full backfill in an AsyncLocalStorage scope so the
  // API-call count we report is *this* run's calls only — not leaked
  // from any concurrent Tekmetric operation in the same Node process.
  return runWithTekmetricApiCallTracking(async (apiCallCounter) => {
  try {
    const body = await req.json().catch(() => ({}));
    const targetShopId = body.shopId ? Number(body.shopId) : null;

    const shopsToProcess = targetShopId
      ? await (async () => {
          const shop = await db.collection("shops").findOne({ shopId: targetShopId });
          if (!shop) return [];
          const tekmetricShopId = shop.tekmetric?.shopId || shop.tekmetricShopId;
          if (!tekmetricShopId) return [];
          return [{ shopId: targetShopId, name: shop.name || `Shop ${targetShopId}`, tekmetricShopId: Number(tekmetricShopId), hasLastRunAt: false }];
        })()
      : await getShopsNeedingBackfill(db);

    if (shopsToProcess.length === 0) {
      return NextResponse.json({ ok: true, message: "No shops to backfill", shopsRemaining: 0 });
    }

    const MAX_CHUNKS = 25;
    const results: any[] = [];

    for (const shop of shopsToProcess) {
      console.log(`[Tekmetric Backfill] Full backfill starting for: ${shop.name} (Shop ${shop.shopId})`);
      let totalJobs = 0;
      let totalSkipped = 0;
      let totalNormalized = 0;
      let chunksProcessed = 0;

      for (let i = 0; i < MAX_CHUNKS; i++) {
        const result = await backfillShopChunk(db, shop.shopId, shop.tekmetricShopId);
        totalJobs += result.jobsIndexed;
        totalSkipped += result.skipped;
        totalNormalized += result.normalizedCount;
        chunksProcessed++;

        console.log(`[Tekmetric Backfill] Shop ${shop.shopId} chunk ${chunksProcessed}: ${result.message}`);

        if (result.complete) {
          console.log(`[Tekmetric Backfill] Shop ${shop.shopId}: COMPLETE after ${chunksProcessed} chunks`);
          break;
        }

        if (Date.now() - startTime > 270000) {
          console.log(`[Tekmetric Backfill] Shop ${shop.shopId}: Approaching timeout after ${chunksProcessed} chunks, will continue next run`);
          break;
        }

        await new Promise(r => setTimeout(r, 500));
      }

      results.push({
        shopId: shop.shopId,
        name: shop.name,
        chunksProcessed,
        totalJobsIndexed: totalJobs,
        totalSkipped,
        totalNormalized,
        complete: chunksProcessed < MAX_CHUNKS,
      });
    }

    const apiCallCount = apiCallCounter.count;
    const duration = Date.now() - startTime;
    console.log(`[Cron] Tekmetric full backfill completed in ${duration}ms — API calls made: ${apiCallCount} (budget: 600/min)`);

    return NextResponse.json({
      ok: true,
      processed: results,
      duration: `${duration}ms`,
      tekmetricApiCalls: apiCallCount,
    });

  } catch (err: any) {
    const apiCallCount = apiCallCounter.count;
    console.error(`[Tekmetric Backfill] Full backfill error (API calls made: ${apiCallCount}):`, err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
  });
}
