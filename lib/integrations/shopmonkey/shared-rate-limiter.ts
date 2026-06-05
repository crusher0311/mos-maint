/**
 * Cross-process per-second rate limiter for Shopmonkey API calls.
 *
 * Mirrors lib/integrations/tekmetric/shared-rate-limiter.ts (distributed
 * per-second token bucket keyed by unix second) so that multiple Node
 * processes sharing the same Shopmonkey API key cannot collectively blow past
 * Shopmonkey's per-second cap. Shopmonkey's documented budget is ~5 req/s
 * (300/min) — see lib/api-usage-tracker.ts — so the default cap here is 5 with
 * a hard ceiling of 5.
 *
 * Strategy (identical to Tekmetric, Mongo-only — Shopmonkey is net-new so there
 * is no PG-canonical backend to migrate to):
 *   - One Mongo document per second, `_id = "sm:<unix-second>"`.
 *   - Each call atomically `$inc`s `count`; granted when post-inc count <= cap.
 *   - Over cap → release the slot ($inc -1), sleep to the next second, retry.
 *   - A TTL index on `expiresAt` (~10s out) auto-cleans stale buckets.
 *
 * Failure modes match Tekmetric: Mongo unreachable → `{ acquired: true,
 * fallback: true }` (degrade to per-process pacing rather than block all
 * traffic); sustained over-cap → `{ acquired: false, timedOut: true }` after
 * MAX_WAIT_MS and the caller MUST NOT issue the request unless
 * SHOPMONKEY_SHARED_LIMITER_FAIL_OPEN=true.
 */

import { getDb } from "@/lib/mongo";

const COLLECTION = "shopmonkey_rate_buckets";
const HARD_CEILING_RPS = 5;
const DEFAULT_CAP_RPS = 5;
const DEFAULT_USER_RESERVE_RPS = 2;
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
      await db.collection(COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      indexEnsured = true;
      indexEnsureFailedLogged = false;
    } catch (err: any) {
      if (!indexEnsureFailedLogged) {
        indexEnsureFailedLogged = true;
        console.warn(
          `[Shopmonkey SharedLimiter] TTL index ensure failed (continuing, will not log again): ${err?.message || err}`,
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

export function getSharedShopmonkeyRpsCap(): number {
  const raw = parseInt(process.env.SHOPMONKEY_SHARED_RPS_CAP || "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CAP_RPS;
  return Math.min(raw, HARD_CEILING_RPS);
}

export function getSharedShopmonkeyUserReserve(): number {
  const rawEnv = process.env.SHOPMONKEY_SHARED_RPS_USER_RESERVE;
  if (rawEnv === undefined || rawEnv === "") return DEFAULT_USER_RESERVE_RPS;
  const raw = parseInt(rawEnv, 10);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_USER_RESERVE_RPS;
  return raw;
}

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
  return process.env.SHOPMONKEY_SHARED_LIMITER_DISABLED === "true";
}

function isFailOpen(): boolean {
  return process.env.SHOPMONKEY_SHARED_LIMITER_FAIL_OPEN === "true";
}

export interface SharedSlotResult {
  acquired: boolean;
  fallback?: boolean;
  timedOut?: boolean;
  failedOpen?: boolean;
  waitedMs?: number;
}

export interface AcquireSharedSlotOptions {
  priority?: SharedSlotPriority;
  maxWaitMs?: number;
}

export const __deps: { getDb: typeof getDb } = { getDb };

function bucketKey(nowMs: number): string {
  return `sm:${Math.floor(nowMs / 1000)}`;
}

async function incBucket(db: any, key: string, nowMs: number): Promise<number> {
  const res = await db.collection(COLLECTION).findOneAndUpdate(
    { _id: key },
    {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: new Date(nowMs + BUCKET_TTL_MS) },
    },
    { upsert: true, returnDocument: "after" },
  );
  const doc = res?.value ?? res;
  return doc?.count ?? 1;
}

async function decBucket(db: any, key: string): Promise<void> {
  try {
    await db.collection(COLLECTION).updateOne({ _id: key }, { $inc: { count: -1 } });
  } catch {
    /* best-effort */
  }
}

/**
 * Acquire one shared per-second Shopmonkey slot. Mirrors the Tekmetric limiter
 * contract: blocks (sleeping to the next second) until a slot is free or
 * maxWaitMs elapses. Returns `{ acquired: false, timedOut: true }` on timeout
 * (unless fail-open is set), or `{ acquired: true, fallback: true }` if Mongo
 * is unreachable.
 */
export async function acquireSharedShopmonkeySlot(
  options: AcquireSharedSlotOptions = {},
): Promise<SharedSlotResult> {
  if (isSharedLimiterDisabled()) {
    return { acquired: true, fallback: true };
  }

  const priority = options.priority ?? "background";
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const cap = getSharedShopmonkeyRpsCap();
  const userReserve = getSharedShopmonkeyUserReserve();
  const effectiveCap = effectiveCapForPriority(cap, userReserve, priority);

  let db: any;
  try {
    db = await __deps.getDb();
    await ensureIndex(db);
  } catch (err: any) {
    console.warn(`[Shopmonkey SharedLimiter] Mongo unavailable, failing open to per-process pacing: ${err?.message || err}`);
    return { acquired: true, fallback: true };
  }

  const start = Date.now();
  while (true) {
    const now = Date.now();
    const key = bucketKey(now);
    let count: number;
    try {
      count = await incBucket(db, key, now);
    } catch (err: any) {
      console.warn(`[Shopmonkey SharedLimiter] bucket inc failed, failing open: ${err?.message || err}`);
      return { acquired: true, fallback: true };
    }

    if (count <= effectiveCap) {
      return { acquired: true, waitedMs: now - start };
    }

    // Over cap — give the slot back and wait until the next second.
    await decBucket(db, key);

    if (now - start >= maxWaitMs) {
      if (isFailOpen()) {
        console.warn(`[Shopmonkey SharedLimiter] FAIL-OPEN: cap ${effectiveCap} exceeded for ${maxWaitMs}ms, letting request through (SHOPMONKEY_SHARED_LIMITER_FAIL_OPEN=true).`);
        return { acquired: true, failedOpen: true, waitedMs: now - start };
      }
      return { acquired: false, timedOut: true, waitedMs: now - start };
    }

    const msToNextSecond = 1000 - (now % 1000);
    await new Promise((r) => setTimeout(r, Math.min(msToNextSecond, maxWaitMs - (now - start))));
  }
}
