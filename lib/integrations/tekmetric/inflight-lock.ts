/**
 * Per-shop in-flight lock for the Tekmetric full-page backfill.
 *
 * Why this exists: the full-page backfill route
 * (`app/api/cron/tekmetric-fullpage-backfill/route.ts`) has both a GET
 * cron entry point and a POST `{shopId}` manual entry point, and neither
 * had any per-shop concurrency control. Render's edge timeout
 * disconnects long-running curl requests at ~280s but the Node promise
 * keeps running on the server; manual retries during ops debugging
 * therefore stack up multiple concurrent runs of the same shop. On
 * 2026-05-09 this produced 4 simultaneous pre-pass runs for shop 112,
 * each reading the same `prePassNextPage` and competing for the shared
 * 8 RPS Tekmetric budget. Net result: ~70 minutes of wall clock for one
 * page of progress and ~8000 wasted API calls.
 *
 * The lock is stored on the existing `tekmetric_backfill_progress` doc
 * (one per shop) so it sits next to the rest of the per-shop progress
 * state. It has a TTL — a crashed or killed run does not permanently
 * block the shop. The next caller after the TTL expires can take the
 * lock cleanly.
 *
 * Release is owner-scoped: a process can only release a lock it
 * currently holds. This prevents a stale `finally` block in a runaway
 * promise from clearing a lock that the TTL has already handed off to
 * a new run.
 */

import os from "os";

export const PROGRESS_COLLECTION = "tekmetric_backfill_progress";

// Default TTL: longer than the route handler's deadline (270s) plus a
// generous safety margin for shutdown / GC / Mongo write latency. Six
// minutes means a crashed run blocks the shop for at most ~3 minutes
// past the next cron tick — acceptable, and short enough that shop
// 112-style stuck states self-heal during the same debugging session.
export const DEFAULT_LOCK_TTL_MS = 6 * 60 * 1000;

// Heartbeat staleness threshold: a lock whose heartbeat hasn't been
// bumped in this many ms is treated as abandoned and may be taken over
// even before the TTL expires. The chunker and pre-pass code bumps the
// heartbeat after every page write (~20-30s wall clock), so a 3-minute
// gap is unambiguous evidence that the holder is wedged (not just
// slow). This unblocks the shop-82/122-style failure mode where each
// cron tick acquires the lock, makes no page progress before Render's
// edge kills the route at ~280s, and the next tick is locked out for
// the full 6-minute TTL — repeating indefinitely. Diagnosed in #443
// (last real page progress 2026-05-10 despite daily lock reacquisition).
export const DEFAULT_STALE_HEARTBEAT_MS = 3 * 60 * 1000;

export type InFlightLockHandle = {
  acquired: true;
  shopId: number;
  owner: string;
  startedAt: Date;
  expiresAt: Date;
  // True when this acquisition took over an active lock whose heartbeat
  // had gone stale (caller may want to log this prominently — it means
  // the previous holder was wedged, not a clean handoff).
  stolenFromStaleHolder?: boolean;
  previousOwner?: string | null;
};

export type InFlightLockBusy = {
  acquired: false;
  shopId: number;
  heldBy: string | null;
  heldUntil: Date | null;
  startedAt: Date | null;
  heartbeatAt: Date | null;
};

export type InFlightLockResult = InFlightLockHandle | InFlightLockBusy;

function buildOwnerId(): string {
  const host = process.env.HOSTNAME || os.hostname() || "unknown";
  return `${host}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Atomically attempt to take the per-shop in-flight lock.
 *
 * Behavior:
 *   - If the progress doc doesn't exist, insert it with the lock fields
 *     set. A concurrent insert (E11000) loses the race and reports busy.
 *   - If the progress doc exists with no lock or an expired lock, take
 *     it atomically via findOneAndUpdate. The filter and update are a
 *     single round trip, so two callers cannot both win.
 *   - If the progress doc exists with an active lock, return busy with
 *     the existing lock metadata so callers can surface it to the user.
 */
export async function acquireInFlightLock(
  db: any,
  shopId: number,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
  staleHeartbeatMs: number = DEFAULT_STALE_HEARTBEAT_MS,
): Promise<InFlightLockResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const staleBefore = new Date(now.getTime() - staleHeartbeatMs);
  const owner = buildOwnerId();

  // Capture the prior holder up-front so we can emit a stolen-from log
  // when the heartbeat-staleness branch wins. Cheap read, runs once
  // per acquire attempt.
  const priorDoc = await db
    .collection(PROGRESS_COLLECTION)
    .findOne(
      { shopId },
      {
        projection: {
          inFlightOwner: 1,
          inFlightUntil: 1,
          inFlightStartedAt: 1,
          inFlightHeartbeatAt: 1,
        },
      },
    );
  const priorOwner = priorDoc?.inFlightOwner || null;
  const priorHeartbeat = priorDoc?.inFlightHeartbeatAt
    ? new Date(priorDoc.inFlightHeartbeatAt)
    : null;
  const priorStartedAt = priorDoc?.inFlightStartedAt
    ? new Date(priorDoc.inFlightStartedAt)
    : null;
  const priorUntil = priorDoc?.inFlightUntil
    ? new Date(priorDoc.inFlightUntil)
    : null;

  // Step 1: try to take a free, TTL-expired, OR heartbeat-stale lock on
  // an existing doc. The heartbeat branch is the #443 fix: a lock whose
  // holder is wedged (acquired but writing no pages) gets stolen long
  // before the 6-minute TTL fires.
  //
  // Heartbeat-stale means: the lock has been held long enough that the
  // chunker should have written at least one page (~30s) AND the
  // heartbeat (which the chunker bumps after every page write) hasn't
  // ticked. We require BOTH `inFlightStartedAt < staleBefore` AND
  // `(inFlightHeartbeatAt < staleBefore OR no heartbeat)` so a freshly
  // acquired lock that hasn't bumped a heartbeat yet isn't stolen
  // mid-first-page.
  const res = await db.collection(PROGRESS_COLLECTION).findOneAndUpdate(
    {
      shopId,
      $or: [
        { inFlightUntil: { $exists: false } },
        { inFlightUntil: null },
        { inFlightUntil: { $lte: now } },
        {
          inFlightStartedAt: { $lt: staleBefore },
          $or: [
            { inFlightHeartbeatAt: { $exists: false } },
            { inFlightHeartbeatAt: null },
            { inFlightHeartbeatAt: { $lt: staleBefore } },
          ],
        },
      ],
    },
    {
      $set: {
        inFlightUntil: expiresAt,
        inFlightStartedAt: now,
        inFlightHeartbeatAt: now,
        inFlightOwner: owner,
      },
    },
    { returnDocument: "after" },
  );

  // Mongo driver versions return the matched doc either at `res.value`
  // or directly as `res`. Cover both.
  const updated = res?.value ?? res;
  if (updated && updated.inFlightOwner === owner) {
    // Detect whether we stole from a still-active-but-wedged holder
    // (TTL not yet expired) so the caller can log it as a recovery
    // event rather than an ordinary handoff.
    const stolen =
      !!priorOwner &&
      !!priorUntil &&
      priorUntil.getTime() > now.getTime() &&
      priorOwner !== owner;
    if (stolen) {
      const heldForSec = priorStartedAt
        ? Math.round((now.getTime() - priorStartedAt.getTime()) / 1000)
        : null;
      const lastBeatSec = priorHeartbeat
        ? Math.round((now.getTime() - priorHeartbeat.getTime()) / 1000)
        : null;
      console.warn(
        `[Tekmetric InFlightLock] Shop ${shopId}: stole stale lock from ${priorOwner} (held ${heldForSec}s, last heartbeat ${lastBeatSec === null ? "never" : `${lastBeatSec}s ago`}). New owner=${owner}.`,
      );
    }
    return {
      acquired: true,
      shopId,
      owner,
      startedAt: now,
      expiresAt,
      stolenFromStaleHolder: stolen,
      previousOwner: stolen ? priorOwner : null,
    };
  }

  // Step 2: no matching doc. Either the doc doesn't exist, or the lock
  // is held by someone else. Distinguish by reading.
  const existing = await db
    .collection(PROGRESS_COLLECTION)
    .findOne({ shopId });
  if (existing) {
    return {
      acquired: false,
      shopId,
      heldBy: existing.inFlightOwner || null,
      heldUntil: existing.inFlightUntil || null,
      startedAt: existing.inFlightStartedAt || null,
      heartbeatAt: existing.inFlightHeartbeatAt || null,
    };
  }

  // Step 3: doc doesn't exist yet. Insert with the lock fields. A
  // concurrent insert (or recently-completed update) will collide on
  // the shopId unique index and we report busy.
  try {
    await db.collection(PROGRESS_COLLECTION).insertOne({
      shopId,
      inFlightUntil: expiresAt,
      inFlightStartedAt: now,
      inFlightHeartbeatAt: now,
      inFlightOwner: owner,
    });
    return { acquired: true, shopId, owner, startedAt: now, expiresAt };
  } catch (err: any) {
    if (err?.code === 11000) {
      const after = await db
        .collection(PROGRESS_COLLECTION)
        .findOne({ shopId });
      return {
        acquired: false,
        shopId,
        heldBy: after?.inFlightOwner || null,
        heldUntil: after?.inFlightUntil || null,
        startedAt: after?.inFlightStartedAt || null,
        heartbeatAt: after?.inFlightHeartbeatAt || null,
      };
    }
    throw err;
  }
}

/**
 * Bump the heartbeat on the per-shop in-flight lock to signal that the
 * holder is making real progress (i.e. just wrote a page). Without
 * regular heartbeats, the next acquire attempt will steal the lock
 * after DEFAULT_STALE_HEARTBEAT_MS even though the TTL hasn't expired.
 *
 * Owner-scoped: a stolen lock can't have its heartbeat bumped by the
 * original holder. Best-effort and idempotent — errors are logged but
 * not thrown because heartbeat misses just expose the lock to faster
 * takeover, never to data loss.
 */
export async function bumpInFlightHeartbeat(
  db: any,
  shopId: number,
  owner: string,
): Promise<void> {
  try {
    await db
      .collection(PROGRESS_COLLECTION)
      .updateOne(
        { shopId, inFlightOwner: owner },
        { $set: { inFlightHeartbeatAt: new Date() } },
      );
  } catch (err: any) {
    console.warn(
      `[Tekmetric InFlightLock] heartbeat bump failed for shop ${shopId} (owner=${owner}): ${err?.message || err}`,
    );
  }
}

/**
 * Release a lock previously acquired by this process. Owner-scoped so a
 * stale `finally` block in a runaway promise cannot clear a lock that
 * the TTL has already handed off to a new run.
 *
 * Idempotent and best-effort: errors are swallowed because the TTL is
 * the real safety net.
 */
export async function releaseInFlightLock(
  db: any,
  shopId: number,
  owner: string,
): Promise<void> {
  await db
    .collection(PROGRESS_COLLECTION)
    .updateOne(
      { shopId, inFlightOwner: owner },
      {
        $unset: {
          inFlightUntil: "",
          inFlightStartedAt: "",
          inFlightOwner: "",
        },
      },
    )
    .catch((err: any) => {
      console.warn(
        `[Tekmetric InFlightLock] release failed for shop ${shopId} (owner=${owner}): ${err?.message || err}`,
      );
    });
}
