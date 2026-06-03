/**
 * Pure helpers for the whole-pipeline backfill stall alerter.
 *
 * Extracted from `route.ts` so the fleet-progress heartbeat, drain-lease
 * wedge detection, queue roll-up, and dedup-key builder can be unit-tested
 * without spinning up Mongo, Resend, or Slack. This file has no I/O.
 *
 * The companion per-shop alerters (`tekmetric-backfill-health`,
 * `backfill-chunk-speed-health`) page when ONE shop trips a threshold. The
 * `cron-health-alerter` pages when a cron stops returning 200. Neither
 * catches the failure mode this file targets: the backfill cron keeps
 * returning 200 (green) but makes ZERO real data progress across the WHOLE
 * fleet — a wedged global drain lease or a loop that no-ops every tick. That
 * slipped past every existing check for ~2 days.
 */

export type ProviderKey = "tekmetric" | "protractor" | "shopware";

export type ProviderConfig = {
  key: ProviderKey;
  label: string;
  // Mongo collection holding per-shop backfill progress for this provider.
  // NOTE: Shop-Ware's progress lives in the (historically oddly-named) `ln`
  // collection — that's what `shopware-backfill`, `backfill-reconcile`, and
  // `invoice-cache-refresh` all read/write. (The chunk-speed-health cron
  // points at `shopware_backfill_progress`, which is effectively empty; do
  // not copy that here or Shop-Ware stalls would be invisible.)
  collectionName: string;
  // Cron job names (from lib/cron/jobs.cjs) that drive this provider's
  // backfill. Used for the liveness gate: we only flag "no progress" when
  // the loop is demonstrably alive (one of these succeeded recently) yet
  // nothing moved — i.e. running-but-wedged, the gap cron-health misses. A
  // genuinely dead loop (no recent success) is left to cron-health-alerter.
  backfillJobNames: string[];
};

export const PROVIDERS: ProviderConfig[] = [
  {
    key: "tekmetric",
    label: "Tekmetric",
    collectionName: "tekmetric_backfill_progress",
    backfillJobNames: [
      "tekmetric-backfill",
      "weekend-backfill-boost",
      "monday-backfill-catchup-boost",
      "weekday-backfill-boost",
      "new-shop-backfill-fastpath",
      "fullpage-backfill-tekmetric",
    ],
  },
  {
    key: "protractor",
    label: "Protractor",
    collectionName: "backfill_progress",
    backfillJobNames: [
      "protractor-backfill",
      "protractor-weekend-boost",
      "protractor-weekday-boost",
      "protractor-new-shop-fastpath",
    ],
  },
  {
    key: "shopware",
    label: "Shop-Ware",
    collectionName: "ln",
    backfillJobNames: ["shopware-backfill", "shopware-weekend-boost"],
  },
];

// Default "no fleet progress" window. Tunable via PIPELINE_STALL_WINDOW_MS.
// 3h is comfortably longer than any single backfill tick + normal rate-limit
// backoff (chunks are <10min) yet short enough that a wedged lease is caught
// the same day instead of going unnoticed for ~2 days.
export const DEFAULT_STALL_WINDOW_MS = 3 * 60 * 60 * 1000;

// Default max sane drain-lease hold. Tunable via PIPELINE_DRAIN_WEDGE_MS.
// A healthy operator drain refreshes every 60s and is normally a short
// burst; a lease whose ACQUISITION is older than this (and still live or
// only just expired) means a drain is wedged/forgotten and the cron has
// been paused too long.
export const DEFAULT_DRAIN_WEDGE_MS = 30 * 60 * 1000;

// Default queue failed-job count that escalates on its own. Tunable via
// PIPELINE_QUEUE_FAILED_THRESHOLD. Below this, queue counts are still
// included in the payload of any other alert for context.
export const DEFAULT_QUEUE_FAILED_THRESHOLD = 50;

function toMs(v: any): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export type ProgressSignature = {
  completedShops: number;
  incompleteShops: number;
  // Aggregates that ONLY change when real data progress happens. lastRunAt is
  // deliberately excluded: the cron bumps it every tick even on a no-op, so
  // including it would mask exactly the stall we're hunting.
  maxCursorMoveAtMs: number;
  sumCurrentChunkEndMs: number;
  sumProgressCounters: number;
  // Compact stable string used for change detection across ticks.
  signature: string;
};

/**
 * Roll up a provider's per-shop progress rows into a signature whose value
 * changes if and only if some shop made real forward progress (cursor
 * advanced, a monotonic counter climbed, or a shop completed) since the
 * prior tick.
 */
export function computeProgressSignature(progressRows: any[]): ProgressSignature {
  let completedShops = 0;
  let incompleteShops = 0;
  let maxCursorMoveAtMs = 0;
  let sumCurrentChunkEndMs = 0;
  let sumProgressCounters = 0;

  for (const p of progressRows) {
    const complete = p?.completed === true || p?.complete === true;
    if (complete) {
      completedShops += 1;
      continue;
    }
    incompleteShops += 1;

    const cursorMs = toMs(p?.lastCursorMoveAt);
    if (cursorMs != null && cursorMs > maxCursorMoveAtMs) maxCursorMoveAtMs = cursorMs;

    const chunkEndMs = toMs(p?.currentChunkEnd);
    if (chunkEndMs != null) sumCurrentChunkEndMs += chunkEndMs;

    sumProgressCounters +=
      num(p?.fullPageNextPage) +
      num(p?.prePassNextPage) +
      num(p?.vehiclesPrePassNextPage) +
      num(p?.customersPrePassNextPage) +
      num(p?.totalRosProcessed) +
      num(p?.totalJobsIndexed) +
      num(p?.totalJobsIndexed === undefined ? p?.totalRosStored : 0);
  }

  const signature = [
    completedShops,
    incompleteShops,
    maxCursorMoveAtMs,
    sumCurrentChunkEndMs,
    sumProgressCounters,
  ].join("|");

  return {
    completedShops,
    incompleteShops,
    maxCursorMoveAtMs,
    sumCurrentChunkEndMs,
    sumProgressCounters,
    signature,
  };
}

export type StallDecision = {
  stalled: boolean;
  stalledMs: number | null;
  // True when there's no progress but the loop also isn't running — handed
  // off to cron-health-alerter rather than paged here.
  deferredToCronHealth?: boolean;
};

/**
 * Decide whether a provider's fleet is stalled: incomplete shops exist, the
 * progress signature has been frozen for >= windowMs, AND the backfill loop
 * is demonstrably alive (a backfill cron succeeded within livenessWindowMs).
 * If the loop is NOT alive, this is plain loop-death which cron-health owns.
 */
export function decidePipelineStall(args: {
  incompleteShops: number;
  stalledMs: number | null;
  windowMs: number;
  lastBackfillSuccessMs: number | null;
  nowMs: number;
  livenessWindowMs: number;
}): StallDecision {
  const { incompleteShops, stalledMs, windowMs, lastBackfillSuccessMs, nowMs, livenessWindowMs } =
    args;
  if (incompleteShops <= 0) return { stalled: false, stalledMs };
  if (stalledMs == null || stalledMs < windowMs) return { stalled: false, stalledMs };
  const alive =
    lastBackfillSuccessMs != null && nowMs - lastBackfillSuccessMs <= livenessWindowMs;
  if (!alive) return { stalled: false, stalledMs, deferredToCronHealth: true };
  return { stalled: true, stalledMs };
}

export type DrainWedge = {
  owner: string;
  heldMs: number;
  acquiredAt: string | null;
  expiresAt: string | null;
  lastRefreshAt: string | null;
  live: boolean;
};

/**
 * Detect a global Tekmetric drain lease held too long. A healthy operator
 * drain is a short, self-releasing burst; a lease whose acquisition is older
 * than maxHeldMs and is still live (or only just expired) means a drain is
 * wedged/forgotten and the backfill cron has been paused that whole time.
 */
export function decideDrainWedge(
  lock: any,
  nowMs: number,
  maxHeldMs: number,
): DrainWedge | null {
  if (!lock) return null;
  const acquiredAtMs = toMs(lock.acquiredAt);
  const expiresAtMs = toMs(lock.expiresAt);
  const heldMs = acquiredAtMs != null ? nowMs - acquiredAtMs : null;
  if (heldMs == null || heldMs < maxHeldMs) return null;
  const live = expiresAtMs != null && expiresAtMs > nowMs;
  // Only flag if it's still live, or expired so recently that the cron is
  // still effectively blocked (the stale-lock cleaner runs out-of-band). A
  // long-expired lease is genuinely abandoned and handled elsewhere.
  const justExpired = expiresAtMs != null && nowMs - expiresAtMs < maxHeldMs;
  if (!live && !justExpired) return null;
  return {
    owner: lock.owner ? String(lock.owner) : "unknown",
    heldMs,
    acquiredAt: acquiredAtMs != null ? new Date(acquiredAtMs).toISOString() : null,
    expiresAt: expiresAtMs != null ? new Date(expiresAtMs).toISOString() : null,
    lastRefreshAt: toMs(lock.lastRefreshAt) != null ? new Date(toMs(lock.lastRefreshAt)!).toISOString() : null,
    live,
  };
}

export type QueueRollup = {
  enabled: boolean;
  totalFailed: number;
  // BullMQ surfaces stalled jobs as a transient sub-state; the snapshot API
  // doesn't break it out, so "stalled-ish" is approximated as active jobs in
  // a paused queue. Kept separate so the field is ready when the queue ships.
  totalStalled: number;
  byQueue: Array<{ name: string; failed: number; active: number; waiting: number; paused: number }>;
  breaches: string[];
};

/**
 * Summarize BullMQ queue snapshots for the alert. When the queue is disabled
 * (no REDIS_URL) this returns `{ enabled:false }` and never contributes a
 * breach — matching the task's "once the queue is live" gating.
 */
export function summarizeQueue(
  snapshots: Array<{ name: string; counts: any | null }> | null,
  failedThreshold: number,
  enabled: boolean,
): QueueRollup {
  if (!enabled || !snapshots) {
    return { enabled: false, totalFailed: 0, totalStalled: 0, byQueue: [], breaches: [] };
  }
  let totalFailed = 0;
  let totalStalled = 0;
  const byQueue: QueueRollup["byQueue"] = [];
  const breaches: string[] = [];
  for (const s of snapshots) {
    const c = s.counts || {};
    const failed = num(c.failed);
    const active = num(c.active);
    const waiting = num(c.waiting);
    const paused = num(c.paused);
    const stalled = paused > 0 ? active : 0;
    totalFailed += failed;
    totalStalled += stalled;
    byQueue.push({ name: String(s.name), failed, active, waiting, paused });
    if (failed >= failedThreshold) breaches.push(`queue:${s.name}`);
  }
  return { enabled: true, totalFailed, totalStalled, byQueue, breaches };
}

export type StallHit =
  | { reason: "no_progress"; provider: ProviderKey; providerLabel: string; stalledMs: number; incompleteShops: number; lastBackfillSuccessMs: number | null }
  | { reason: "drain_wedge"; provider: "tekmetric"; providerLabel: "Tekmetric"; wedge: DrainWedge }
  | { reason: "queue_backlog"; queues: string[]; totalFailed: number; totalStalled: number };

/**
 * Build a stable dedup key from the current breach set. Re-page only when
 * this key changes (a provider added/dropped, the wedge appeared/cleared,
 * the queue breached). Sorted so ordering can't churn the key.
 */
export function buildAlertKey(hits: StallHit[]): string {
  const tokens: string[] = [];
  for (const h of hits) {
    if (h.reason === "no_progress") tokens.push(`progress:${h.provider}`);
    else if (h.reason === "drain_wedge") tokens.push("wedge:tekmetric");
    else if (h.reason === "queue_backlog") tokens.push(...h.queues);
  }
  return tokens.sort().join(",");
}
