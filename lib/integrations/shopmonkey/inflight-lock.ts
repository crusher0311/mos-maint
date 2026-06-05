/**
 * Per-shop in-flight lock for the Shopmonkey full-page backfill.
 *
 * Verbatim mirror of lib/integrations/tekmetric/inflight-lock.ts (same TTL +
 * heartbeat-steal semantics) but stored on the Shopmonkey progress doc
 * (`shopmonkey_backfill_progress`, one per shop) so a crashed/killed run never
 * permanently blocks a shop. Release is owner-scoped: a process can only
 * release a lock it currently holds, so a stale `finally` in a runaway promise
 * can't clear a lock the TTL has already handed off.
 */

import os from "os";

export const PROGRESS_COLLECTION = "shopmonkey_backfill_progress";

export const DEFAULT_LOCK_TTL_MS = 6 * 60 * 1000;
export const DEFAULT_STALE_HEARTBEAT_MS = 3 * 60 * 1000;

export type InFlightLockHandle = {
  acquired: true;
  shopId: number;
  owner: string;
  startedAt: Date;
  expiresAt: Date;
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

  const priorDoc = await db.collection(PROGRESS_COLLECTION).findOne(
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
  const priorHeartbeat = priorDoc?.inFlightHeartbeatAt ? new Date(priorDoc.inFlightHeartbeatAt) : null;
  const priorStartedAt = priorDoc?.inFlightStartedAt ? new Date(priorDoc.inFlightStartedAt) : null;
  const priorUntil = priorDoc?.inFlightUntil ? new Date(priorDoc.inFlightUntil) : null;

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

  const updated = res?.value ?? res;
  if (updated && updated.inFlightOwner === owner) {
    const stolen =
      !!priorOwner && !!priorUntil && priorUntil.getTime() > now.getTime() && priorOwner !== owner;
    if (stolen) {
      const heldForSec = priorStartedAt ? Math.round((now.getTime() - priorStartedAt.getTime()) / 1000) : null;
      const lastBeatSec = priorHeartbeat ? Math.round((now.getTime() - priorHeartbeat.getTime()) / 1000) : null;
      console.warn(
        `[Shopmonkey InFlightLock] Shop ${shopId}: stole stale lock from ${priorOwner} (held ${heldForSec}s, last heartbeat ${lastBeatSec === null ? "never" : `${lastBeatSec}s ago`}). New owner=${owner}.`,
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

  const existing = await db.collection(PROGRESS_COLLECTION).findOne({ shopId });
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
      const after = await db.collection(PROGRESS_COLLECTION).findOne({ shopId });
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

export async function bumpInFlightHeartbeat(db: any, shopId: number, owner: string): Promise<void> {
  try {
    await db
      .collection(PROGRESS_COLLECTION)
      .updateOne({ shopId, inFlightOwner: owner }, { $set: { inFlightHeartbeatAt: new Date() } });
  } catch (err: any) {
    console.warn(
      `[Shopmonkey InFlightLock] heartbeat bump failed for shop ${shopId} (owner=${owner}): ${err?.message || err}`,
    );
  }
}

export async function releaseInFlightLock(db: any, shopId: number, owner: string): Promise<void> {
  await db
    .collection(PROGRESS_COLLECTION)
    .updateOne(
      { shopId, inFlightOwner: owner },
      { $unset: { inFlightUntil: "", inFlightStartedAt: "", inFlightOwner: "" } },
    )
    .catch((err: any) => {
      console.warn(
        `[Shopmonkey InFlightLock] release failed for shop ${shopId} (owner=${owner}): ${err?.message || err}`,
      );
    });
}
