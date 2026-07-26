/**
 * Cross-process per-second rate limiter for Tekmetric API calls.
 *
 * Why this module exists
 * ----------------------
 * `lib/integrations/core/rate-limiter.ts` enforces RPS with an in-memory
 * queue paced at `1000 / localRpsLimit` ms. That's per-process: each Node
 * process thinks it owns the full Tekmetric budget. The moment two services
 * share the same Tekmetric OAuth credentials (e.g. the main web service +
 * the `mos-tools-east` migration target running concurrently against the
 * same key), combined attempted RPS doubles and Tekmetric's 10 RPS per-key
 * cap is blown right past, producing a 429 storm. Production hit exactly
 * this in 2026-05: the bulk-jobs pre-pass ran at ~2.8 RPS effective
 * (35% of cap) instead of ~7 RPS because >40% of calls were 429ing.
 *
 * Strategy: distributed token bucket keyed by unix second.
 *   - One Mongo document per second of wall clock, `_id = "tek:<unix-second>"`.
 *   - Each call atomically `$inc`s `count` on the current second's doc.
 *   - If the post-increment count is <= cap, the slot is granted.
 *   - If over cap, the caller releases its slot ($inc -1) and sleeps until
 *     the next second's bucket opens, then retries.
 *   - A TTL index on `expiresAt` (≈10s out) auto-cleans stale buckets.
 *
 * Why a per-second bucket and not a leasing scheme?
 *   - The whole API budget renews each second. No carry-over math, no
 *     token refill rate to tune, no clock drift to manage beyond ~1s.
 *   - One Mongo round-trip per call (~5-15ms intra-region) is well below
 *     the local pacer's ~125ms inter-call gap at 8 RPS, so the network
 *     cost doesn't reduce sustainable throughput meaningfully.
 *   - Future contributors don't have to second-guess a clever distributed
 *     algorithm — it's just "increment and check".
 *
 * Failure modes
 * -------------
 *   - Mongo unreachable (connect or query error): we log a warning and
 *     return `{ acquired: true, fallback: true }`. That degrades to the
 *     pre-existing per-process behavior (potential 429s under multi-service
 *     load) rather than blocking all Tekmetric traffic.
 *   - Crash mid-bucket: the next call's $inc is on the same bucket; the
 *     stranded count just expires when the TTL fires (≤10s). No manual
 *     cleanup needed.
 *   - Sustained over-cap pressure: after MAX_WAIT_MS the limiter returns
 *     `{ acquired: false, timedOut: true }` and the caller MUST NOT issue
 *     the request. The retry/backoff loop above us handles re-attempting
 *     on the next attempt window. Letting the request through under
 *     prolonged pressure would defeat the whole point of this module
 *     (it would re-create the 429 storm we built it to prevent).
 *     For break-glass debugging, set `TEKMETRIC_SHARED_LIMITER_FAIL_OPEN=true`
 *     to flip the timeout into a pass-through (logs a high-signal warning
 *     so on-call sees the cap breach immediately).
 *
 * Tuning
 * ------
 *   - `TEKMETRIC_SHARED_RPS_CAP` (default 8, hard ceiling 10): combined
 *     RPS budget across all processes/services using these credentials.
 *     Set to 8 in steady state to stay 20% under Tekmetric's documented
 *     10 RPS cap.
 *   - `TEKMETRIC_SHARED_RPS_USER_RESERVE` (default 3): number of RPS
 *     within the shared cap that ONLY interactive (user-waiting) calls
 *     may consume. Background backfill/cron calls see an effective cap
 *     of `cap - userReserve` and back off once usage exceeds that
 *     threshold — even when interactive callers aren't using their
 *     reserved headroom yet. This is the "priority lane" that prevents
 *     a fleet-wide backfill storm from starving every advisor's VHI
 *     load. The in-process two-lane queue in `lib/integrations/core/
 *     rate-limiter.ts` already orders interactive ahead of background
 *     within one Node process; this env extends that guarantee
 *     cross-process at the Mongo bucket layer. Set to 0 to disable
 *     the reserve (every call sees the full cap, FIFO). Effective
 *     backfill cap is always clamped to at least 1.
 *   - `TEKMETRIC_SHARED_LIMITER_DISABLED=true` short-circuits the limiter
 *     for break-glass debugging (falls back to per-process behavior).
 *
 * Inspecting live state
 * ---------------------
 *   db.tekmetric_rate_buckets.find().sort({_id: -1}).limit(10)
 * shows the most recent per-second bucket counts. A spike to or above the
 * cap means the limiter is doing its job (callers waited); persistent low
 * counts under load means it's being bypassed (check the warning logs for
 * "Mongo unavailable" or "TEKMETRIC_SHARED_LIMITER_DISABLED").
 */

import { getDb } from "@/lib/mongo";

const COLLECTION = "tekmetric_rate_buckets";
const HARD_CEILING_RPS = 10;
const DEFAULT_CAP_RPS = 8;
const DEFAULT_USER_RESERVE_RPS = 3;
const MAX_WAIT_MS = 5_000;
const BUCKET_TTL_MS = 10_000;

export type SharedSlotPriority = "interactive" | "background";

let indexEnsured = false;
let indexEnsureFailedLogged = false;
let indexEnsurePromise: Promise<void> | null = null;

async function ensureIndex(db: any): Promise<void> {
  if (indexEnsured) return;
  if (indexEnsurePromise) return indexEnsurePromise;
  indexEnsurePromise = (async () => {
    try {
      await db
        .collection(COLLECTION)
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      indexEnsured = true;
      indexEnsureFailedLogged = false;
    } catch (err: any) {
      // Non-fatal: TTL just won't fire, buckets accumulate harmlessly
      // (each one is ~80 bytes). Log once per process lifetime to avoid
      // spamming logs when the failure is persistent (e.g. a missing
      // createIndex permission on the Mongo user).
      if (!indexEnsureFailedLogged) {
        indexEnsureFailedLogged = true;
        console.warn(
          `[Tekmetric SharedLimiter] TTL index ensure failed (continuing, will not log again): ${err?.message || err}`,
        );
      }
    } finally {
      indexEnsurePromise = null;
    }
  })();
  return indexEnsurePromise;
}

/** Reset the cached "index ensured" flag. Test-only seam. */
export function __resetIndexEnsuredForTest(): void {
  indexEnsured = false;
  indexEnsureFailedLogged = false;
  indexEnsurePromise = null;
}

export function getSharedTekmetricRpsCap(): number {
  const raw = parseInt(process.env.TEKMETRIC_SHARED_RPS_CAP || "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CAP_RPS;
  return Math.min(raw, HARD_CEILING_RPS);
}

/**
 * RPS within the shared cap that ONLY interactive callers may consume.
 * Background calls back off once bucket usage exceeds `cap - userReserve`.
 *
 * Reads `TEKMETRIC_SHARED_RPS_USER_RESERVE` (default 3). Negative values
 * and NaN fall back to the default; zero disables the reserve (every
 * call sees the full cap, FIFO). The reserve is bounded above by
 * `cap - 1` at evaluation time so background never collapses to 0
 * effective cap — see `effectiveCapForPriority`.
 */
export function getSharedTekmetricUserReserve(): number {
  const rawEnv = process.env.TEKMETRIC_SHARED_RPS_USER_RESERVE;
  if (rawEnv === undefined || rawEnv === "") return DEFAULT_USER_RESERVE_RPS;
  const raw = parseInt(rawEnv, 10);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_USER_RESERVE_RPS;
  return raw;
}

/**
 * Effective per-second cap a caller of `priority` sees. Interactive sees
 * the full `cap`; background sees `cap - userReserve`, clamped to at
 * least 1 so a misconfigured reserve cannot wedge backfill traffic to
 * zero. Exported for tests and observability.
 */
export function effectiveCapForPriority(
  cap: number,
  userReserve: number,
  priority: SharedSlotPriority,
): number {
  if (priority === "interactive") return cap;
  const reserved = Math.max(0, Math.min(userReserve, cap - 1));
  return Math.max(1, cap - reserved);
}

export function isSharedLimiterDisabled(): boolean {
  return process.env.TEKMETRIC_SHARED_LIMITER_DISABLED === "true";
}

/**
 * Backend selector (task #557, Mongo → Postgres migration). When
 * `TEKMETRIC_SHARED_LIMITER_PG_CANONICAL=1` the per-second token bucket is
 * kept in the Postgres `tekmetric_rate_buckets` table instead of the Mongo
 * collection. Default-off preserves the current Mongo behavior, so flipping
 * it is an operator action on the production deploy. The cap math, priority
 * lanes, fail-open/closed timeout behavior, and graceful fallback-on-error
 * are identical across both backends — only the increment/decrement storage
 * differs.
 */
export function isSharedLimiterPgCanonical(): boolean {
  return process.env.TEKMETRIC_SHARED_LIMITER_PG_CANONICAL === "1";
}

/**
 * Per-second bucket storage backend. Both implementations expose the same
 * two atomic primitives the limiter loop needs: increment-and-return-count,
 * and decrement (used to release a slot when the caller is over cap).
 */
interface BucketBackend {
  /** Atomically `+1` the current second's bucket and return the new count. */
  inc(key: string, nowMs: number): Promise<number>;
  /** Best-effort `-1` to release a slot the caller decided not to use. */
  dec(key: string): Promise<void>;
}

function mongoBucketBackend(db: any): BucketBackend {
  return {
    async inc(key: string, nowMs: number): Promise<number> {
      const result: any = await db.collection(COLLECTION).findOneAndUpdate(
        { _id: key },
        {
          $inc: { count: 1 },
          $setOnInsert: {
            createdAt: new Date(nowMs),
            expiresAt: new Date(nowMs + BUCKET_TTL_MS),
          },
        },
        { upsert: true, returnDocument: "after" },
      );
      // Mongo driver returns the doc directly in newer versions, or
      // `{ value, ok, ... }` in older ones.
      return result?.value?.count ?? result?.count ?? 1;
    },
    async dec(key: string): Promise<void> {
      await db.collection(COLLECTION).updateOne({ _id: key }, { $inc: { count: -1 } });
    },
  };
}

// Task #946: expired-bucket sweep coordination. Per-process throttle plus a
// PG advisory xact lock so concurrent workers never contend on the same
// DELETE. See the call site in `pgBucketBackend.inc` for the rationale.
const SWEEP_MIN_INTERVAL_MS = 30_000;
let lastPgSweepAttemptMs = 0;

function maybeSweepExpiredPgBuckets(sql: any): void {
  const now = Date.now();
  if (now - lastPgSweepAttemptMs < SWEEP_MIN_INTERVAL_MS) return;
  if (Math.random() >= 0.01) return;
  lastPgSweepAttemptMs = now;
  // `pg_try_advisory_xact_lock` makes this a cross-process mutex: if another
  // worker's sweep already holds the lock, the predicate is false and this
  // statement deletes nothing and returns immediately (no row-lock waits).
  // The lock releases automatically when the statement's implicit
  // transaction ends.
  Promise.resolve(
    sql.unsafe(
      `DELETE FROM tekmetric_rate_buckets
       WHERE expires_at <= now()
         AND pg_try_advisory_xact_lock(hashtext('tekmetric_rate_buckets_sweep'))`,
    ),
  ).catch(() => {});
}

/** Test-only seam: reset the sweep throttle. */
export function __resetPgSweepThrottleForTest(): void {
  lastPgSweepAttemptMs = 0;
}

function pgBucketBackend(sql: any): BucketBackend {
  return {
    async inc(key: string, _nowMs: number): Promise<number> {
      const rows: any = await sql.unsafe(
        `INSERT INTO tekmetric_rate_buckets (bucket_key, count, created_at, expires_at)
         VALUES ($1, 1, now(), now() + ($2::bigint * interval '1 millisecond'))
         ON CONFLICT (bucket_key) DO UPDATE
           SET count = tekmetric_rate_buckets.count + 1
         RETURNING count`,
        [key, BUCKET_TTL_MS],
      );
      const count = Array.isArray(rows) && rows.length > 0 ? Number(rows[0].count) : 1;
      // Postgres has no Mongo-style TTL index, so sweep expired buckets
      // opportunistically to keep the table tiny. Fire and forget — failure
      // here never affects the acquire decision.
      //
      // Task #946: the old bare `Math.random() < 0.01` sweep raced across
      // workers — under fleet-wide load several processes would fire the
      // same DELETE in the same second and contend on the same expired rows.
      // Two guards now serialize it:
      //   1. A per-process throttle (at most one sweep attempt per
      //      SWEEP_MIN_INTERVAL_MS, still jittered by the 1% dice roll) so a
      //      hot process doesn't spam sweeps.
      //   2. A Postgres advisory xact lock inside the DELETE itself, so even
      //      when two processes' sweeps do coincide, exactly one performs the
      //      delete and the other no-ops instantly instead of blocking on
      //      row locks.
      maybeSweepExpiredPgBuckets(sql);
      return count;
    },
    async dec(key: string): Promise<void> {
      await sql.unsafe(
        `UPDATE tekmetric_rate_buckets SET count = count - 1 WHERE bucket_key = $1`,
        [key],
      );
    },
  };
}

/** Lazily resolve the app's shared postgres-js client for the PG backend. */
async function getSharedLimiterPgClient(): Promise<any> {
  const { getClient } = await import("@/lib/db/drizzle");
  return getClient();
}

export interface SharedSlotResult {
  acquired: boolean;
  waitedMs: number;
  /** True when the limiter could not coordinate via Mongo and degraded
   *  to per-process behavior. */
  fallback?: boolean;
  /** True when the limiter waited the full MAX_WAIT_MS without ever
   *  seeing an available slot and let the request through anyway. */
  timedOut?: boolean;
}

export interface AcquireSharedSlotOptions {
  /** Override the cap for this call (still bounded by HARD_CEILING_RPS). */
  capOverride?: number;
  /**
   * Priority lane. `interactive` (default) sees the full shared cap and
   * is what VHI loads, dashboard fetches, extension calls, and anything
   * a human is waiting on should use. `background` sees an effective
   * cap of `cap - userReserve` (default 8 - 3 = 5) so backfills/cron
   * sweeps yield headroom even when the bucket has room. Default is
   * `interactive` so unaudited callers keep their current behavior;
   * backfill paths must opt in explicitly. See
   * `effectiveCapForPriority` for the math.
   */
  priority?: SharedSlotPriority;
  /** Override the per-call user reserve. Default reads env. */
  userReserveOverride?: number;
  /** Test seam: clock source. */
  nowMs?: () => number;
  /** Test seam: sleep function. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: inject a Mongo db (skips the real getDb call). */
  dbOverride?: any;
  /**
   * Test seam: inject a postgres-js-like client (exposing `.unsafe`) for the
   * PG backend, skipping the real `getClient()` call. Only consulted when the
   * PG backend is active (`TEKMETRIC_SHARED_LIMITER_PG_CANONICAL=1`).
   */
  pgOverride?: any;
}

/**
 * Acquire one slot in the shared per-second token bucket.
 *
 * Possible return shapes:
 *   - `{ acquired: true }` — slot granted, caller may issue the request.
 *   - `{ acquired: true, fallback: true }` — Mongo unavailable or limiter
 *     disabled; caller may issue the request, but cross-process pacing
 *     is not in effect.
 *   - `{ acquired: false, timedOut: true }` — sustained over-cap pressure
 *     for MAX_WAIT_MS. Caller MUST NOT issue the request (would defeat
 *     the limiter's purpose). Caller's existing retry loop should re-call
 *     us on the next attempt. The pre-existing 429 backoff logic handles
 *     the case where the over-cap pressure is so prolonged that we
 *     exhaust attempts.
 *
 * The fail-closed behavior on timeout can be flipped to fail-open (return
 * `acquired:true, timedOut:true`) by setting
 * `TEKMETRIC_SHARED_LIMITER_FAIL_OPEN=true`. That should only be used as
 * a break-glass — it allows over-cap traffic through, which is what this
 * module exists to prevent.
 */
export const __deps: { getDb: typeof getDb } = { getDb };

function isFailOpenOnTimeout(): boolean {
  return process.env.TEKMETRIC_SHARED_LIMITER_FAIL_OPEN === "true";
}

export async function acquireSharedTekmetricSlot(
  opts: AcquireSharedSlotOptions = {},
): Promise<SharedSlotResult> {
  // Task #460: per-chunk rate-limiter wait/fallback/timeout accounting.
  // AsyncLocalStorage-scoped (no-op outside a `withChunkWriteCounters`
  // wrapper) so live request paths are unaffected.
  const { bumpRateLimiterWait, bumpRateLimiterTimeout, bumpRateLimiterFallback } =
    await import("@/lib/backfill-metrics/write-counters");

  if (isSharedLimiterDisabled()) {
    bumpRateLimiterFallback();
    return { acquired: true, waitedMs: 0, fallback: true };
  }

  const cap = Math.min(
    opts.capOverride ?? getSharedTekmetricRpsCap(),
    HARD_CEILING_RPS,
  );
  const priority: SharedSlotPriority = opts.priority ?? "interactive";
  const userReserve = opts.userReserveOverride ?? getSharedTekmetricUserReserve();
  const effectiveCap = effectiveCapForPriority(cap, userReserve, priority);
  const nowMs = opts.nowMs ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const usePg = isSharedLimiterPgCanonical();
  let backend: BucketBackend;
  try {
    if (usePg) {
      const sql = opts.pgOverride ?? (await getSharedLimiterPgClient());
      backend = pgBucketBackend(sql);
    } else {
      const db = opts.dbOverride ?? (await __deps.getDb());
      // TTL index is a Mongo-only concern; the PG table's expiry is enforced
      // by the opportunistic sweep in `pgBucketBackend`.
      await ensureIndex(db).catch(() => {});
      backend = mongoBucketBackend(db);
    }
  } catch (err: any) {
    console.warn(
      `[Tekmetric SharedLimiter] ${usePg ? "Postgres" : "Mongo"} unavailable (client init failed), falling back to per-process limiter: ${err?.message || err}`,
    );
    bumpRateLimiterFallback();
    return { acquired: true, waitedMs: 0, fallback: true };
  }

  const startedAt = nowMs();

  while (true) {
    const now = nowMs();
    const second = Math.floor(now / 1000);
    const key = `tek:${second}`;

    let count: number;
    try {
      count = await backend.inc(key, now);
    } catch (err: any) {
      console.warn(
        `[Tekmetric SharedLimiter] ${usePg ? "Postgres" : "Mongo"} error during increment, falling back to per-process limiter: ${err?.message || err}`,
      );
      const waited = nowMs() - startedAt;
      bumpRateLimiterWait(waited);
      bumpRateLimiterFallback();
      return { acquired: true, waitedMs: waited, fallback: true };
    }

    if (count <= effectiveCap) {
      const waited = nowMs() - startedAt;
      bumpRateLimiterWait(waited);
      return { acquired: true, waitedMs: waited };
    }

    // Over cap. Release our slot so we don't poison the bucket for the
    // rest of this second, then wait for the next bucket to open.
    try {
      await backend.dec(key);
    } catch {
      // If the release fails, the stranded count just expires with the
      // bucket. Not worth aborting the retry loop.
    }

    const elapsed = nowMs() - startedAt;
    if (elapsed >= MAX_WAIT_MS) {
      if (isFailOpenOnTimeout()) {
        // Break-glass mode. High-signal warning so on-call notices the
        // cap breach immediately — under fail-open, this log line is
        // proof the limiter is no longer protecting the upstream API.
        console.warn(
          `[Tekmetric SharedLimiter] CAP BREACH (FAIL-OPEN): waited ${elapsed}ms without slot (priority=${priority}, effectiveCap=${effectiveCap}, cap=${cap}), allowing request through because TEKMETRIC_SHARED_LIMITER_FAIL_OPEN=true. Combined attempted RPS may now exceed ${cap}; expect 429s.`,
        );
        bumpRateLimiterWait(elapsed);
        bumpRateLimiterTimeout();
        bumpRateLimiterFallback();
        return { acquired: true, waitedMs: elapsed, timedOut: true };
      }
      // Default fail-closed: tell caller to skip this attempt. The retry
      // loop in tekmetricRequest will re-acquire on its next pass; the
      // existing 429 backoff handles the case where pressure is so
      // sustained that the retry budget is exhausted.
      console.warn(
        `[Tekmetric SharedLimiter] Waited ${elapsed}ms without slot (priority=${priority}, effectiveCap=${effectiveCap}, cap=${cap}); failing closed so caller can backoff/retry instead of breaching the cap`,
      );
      bumpRateLimiterWait(elapsed);
      bumpRateLimiterTimeout();
      return { acquired: false, waitedMs: elapsed, timedOut: true };
    }

    // Sleep until just past the next 1-second boundary. Small jitter
    // (0-50ms) keeps multiple processes from waking in lockstep and
    // re-stampeding the new bucket.
    const msToNextSecond = 1000 - (now % 1000) + Math.floor(Math.random() * 50);
    const remainingBudget = MAX_WAIT_MS - elapsed;
    await sleep(Math.min(msToNextSecond, remainingBudget));
  }
}
