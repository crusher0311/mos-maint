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
const COOLDOWN_COLLECTION = "shopmonkey_rate_cooldowns";
const HARD_CEILING_RPS = 5;
// Cloudflare's edge in front of api.shopmonkey.cloud trips error 1015 well
// below the documented 5 RPS budget under sustained load, so the default
// effective cap is deliberately lower. SHOPMONKEY_SHARED_RPS_CAP can raise it
// back up to the hard ceiling if Shopmonkey's edge tolerance improves.
const DEFAULT_CAP_RPS = 2;
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
      await db.collection(COOLDOWN_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
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

// ---------------------------------------------------------------------------
// Shared per-shop 429 cooldown.
//
// When Shopmonkey (or Cloudflare's 1015 edge limit) returns a 429 for a shop,
// EVERY process sharing that shop's API key must back off — not just the one
// that saw the response. The cooldown is stored per shop in Mongo (with an
// in-process cache so the hot path doesn't pay a read per request) and
// honored by `shopmonkeyRequest` before issuing any call for that shop.
// Best-effort: Mongo being unreachable degrades to the in-process cache.
// ---------------------------------------------------------------------------

const inProcessCooldownUntil = new Map<number, number>();
const COOLDOWN_MAX_MS = 5 * 60_000;

/** Remaining shared cooldown for a shop, in ms (0 when none). */
export async function getSharedShopmonkeyCooldownMs(shopId: number): Promise<number> {
  const now = Date.now();
  const local = inProcessCooldownUntil.get(shopId) ?? 0;
  if (local > now) return local - now;
  try {
    const db = await __deps.getDb();
    const doc = await db
      .collection(COOLDOWN_COLLECTION)
      .findOne({ _id: `sm-cooldown:${shopId}` as any });
    const until = doc?.until instanceof Date ? doc.until.getTime() : Number(doc?.until) || 0;
    if (until > now) {
      inProcessCooldownUntil.set(shopId, until);
      return until - now;
    }
  } catch {
    /* best-effort — fall back to the in-process view */
  }
  return 0;
}

/** Record a shared per-shop cooldown (capped). Extends, never shortens. */
export async function setSharedShopmonkeyCooldown(shopId: number, cooldownMs: number): Promise<void> {
  const bounded = Math.max(0, Math.min(cooldownMs, COOLDOWN_MAX_MS));
  if (bounded === 0) return;
  const until = Date.now() + bounded;
  const prev = inProcessCooldownUntil.get(shopId) ?? 0;
  if (until > prev) inProcessCooldownUntil.set(shopId, until);
  try {
    const db = await __deps.getDb();
    await ensureIndex(db);
    await db.collection(COOLDOWN_COLLECTION).updateOne(
      { _id: `sm-cooldown:${shopId}` as any },
      {
        $max: { until: new Date(until) },
        $set: { expiresAt: new Date(until + 60_000) },
      },
      { upsert: true },
    );
  } catch {
    /* best-effort — the in-process cache still applies */
  }
}

/** Test-only seam: clear the in-process cooldown cache. */
export function __resetCooldownForTest(): void {
  inProcessCooldownUntil.clear();
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
