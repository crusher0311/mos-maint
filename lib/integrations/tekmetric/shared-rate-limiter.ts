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
const MAX_WAIT_MS = 5_000;
const BUCKET_TTL_MS = 10_000;

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

export function isSharedLimiterDisabled(): boolean {
  return process.env.TEKMETRIC_SHARED_LIMITER_DISABLED === "true";
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
  /** Test seam: clock source. */
  nowMs?: () => number;
  /** Test seam: sleep function. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: inject a Mongo db (skips the real getDb call). */
  dbOverride?: any;
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
  if (isSharedLimiterDisabled()) {
    return { acquired: true, waitedMs: 0, fallback: true };
  }

  const cap = Math.min(
    opts.capOverride ?? getSharedTekmetricRpsCap(),
    HARD_CEILING_RPS,
  );
  const nowMs = opts.nowMs ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let db: any;
  try {
    db = opts.dbOverride ?? (await __deps.getDb());
  } catch (err: any) {
    console.warn(
      `[Tekmetric SharedLimiter] Mongo unavailable (getDb failed), falling back to per-process limiter: ${err?.message || err}`,
    );
    return { acquired: true, waitedMs: 0, fallback: true };
  }

  await ensureIndex(db).catch(() => {});

  const startedAt = nowMs();

  while (true) {
    const now = nowMs();
    const second = Math.floor(now / 1000);
    const key = `tek:${second}`;

    let count: number;
    try {
      const result: any = await db.collection(COLLECTION).findOneAndUpdate(
        { _id: key },
        {
          $inc: { count: 1 },
          $setOnInsert: {
            createdAt: new Date(now),
            expiresAt: new Date(now + BUCKET_TTL_MS),
          },
        },
        { upsert: true, returnDocument: "after" },
      );
      // Mongo driver returns the doc directly in newer versions, or
      // `{ value, ok, ... }` in older ones. Match the convention from
      // `lib/data/repositories/api-usage.ts:claimRateLimitSlot`.
      count = result?.value?.count ?? result?.count ?? 1;
    } catch (err: any) {
      console.warn(
        `[Tekmetric SharedLimiter] Mongo error during $inc, falling back to per-process limiter: ${err?.message || err}`,
      );
      return { acquired: true, waitedMs: nowMs() - startedAt, fallback: true };
    }

    if (count <= cap) {
      return { acquired: true, waitedMs: nowMs() - startedAt };
    }

    // Over cap. Release our slot so we don't poison the bucket for the
    // rest of this second, then wait for the next bucket to open.
    try {
      await db
        .collection(COLLECTION)
        .updateOne({ _id: key }, { $inc: { count: -1 } });
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
          `[Tekmetric SharedLimiter] CAP BREACH (FAIL-OPEN): waited ${elapsed}ms without slot (cap=${cap}), allowing request through because TEKMETRIC_SHARED_LIMITER_FAIL_OPEN=true. Combined attempted RPS may now exceed ${cap}; expect 429s.`,
        );
        return { acquired: true, waitedMs: elapsed, timedOut: true };
      }
      // Default fail-closed: tell caller to skip this attempt. The retry
      // loop in tekmetricRequest will re-acquire on its next pass; the
      // existing 429 backoff handles the case where pressure is so
      // sustained that the retry budget is exhausted.
      console.warn(
        `[Tekmetric SharedLimiter] Waited ${elapsed}ms without slot (cap=${cap}); failing closed so caller can backoff/retry instead of breaching the cap`,
      );
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
