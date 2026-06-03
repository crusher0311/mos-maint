/**
 * Pre-cutover readiness check for the BullMQ backfill queue (task #567).
 *
 * Answers one operator question before any shop is routed to the queue:
 * "Is the environment actually ready, and what will the flags do right
 * now?" It is intentionally read-only and never throws — it returns a
 * structured go/no-go so a script or the admin dashboard can render an
 * unambiguous verdict.
 *
 * Three things are probed:
 *   1. Redis reachability — `REDIS_URL` is set AND a `PING` round-trips
 *      within a short budget. A set-but-unreachable Redis is the most
 *      dangerous state (producers fail-open to the legacy path and log
 *      per enqueue), so it's surfaced as a hard blocker.
 *   2. Worker presence — each queue reports how many BullMQ workers are
 *      currently consuming it (`queue.getWorkers()`). Zero consumers on
 *      any queue means jobs would pile up in `waiting` forever, so it's
 *      a hard blocker too.
 *   3. Flag decisions — the current routing verdict for the kill switch,
 *      the global flag, and every per-shop allowlist entry, plus a
 *      synthetic "any other shop" decision. This makes the canary vs
 *      fleet vs off vs kill-switch posture explicit.
 *
 * `ok` is true only when Redis is reachable AND every queue has at least
 * one consumer. Flag posture never affects `ok` (you run this check
 * BEFORE flipping flags) — it's reported as warnings instead.
 */

import { getRedisConnection, isQueueEnabled } from "./connection";
import { ALL_QUEUE_NAMES, getQueue, type QueueName } from "./queues";
import {
  decideQueueFor,
  KILL_SWITCH_ENV,
  GLOBAL_FLAG_ENV,
  PER_SHOP_FLAG_ENV,
} from "./feature-flag";

const PING_TIMEOUT_MS = 3000;

// Sentinel shopId used to report the routing decision for a shop that is
// NOT on the per-shop allowlist — i.e. what the fleet-wide / default
// behavior is. Large positive so it never collides with a real allowlist
// entry while still passing the `> 0` guard in the flag parser.
const SAMPLE_OTHER_SHOP_ID = 999_999_999;

export type RedisReadiness = {
  urlSet: boolean;
  reachable: boolean;
  pingMs: number | null;
  error: string | null;
};

export type QueueWorkerReadiness = {
  name: QueueName;
  workerCount: number;
  error: string | null;
};

export type FlagDecisionReport = {
  shopId: number;
  label: string;
  useQueue: boolean;
  reason: string;
};

export type FlagReadiness = {
  killSwitch: boolean;
  globalEnabled: boolean;
  perShopAllow: number[];
  /** Highest-level posture once Redis + kill switch are accounted for. */
  effectiveMode: "kill_switch" | "redis_missing" | "fleet" | "canary" | "off";
  decisions: FlagDecisionReport[];
};

export type QueueReadiness = {
  ok: boolean;
  generatedAt: string;
  redis: RedisReadiness;
  workers: {
    totalConsuming: number;
    allQueuesCovered: boolean;
    perQueue: QueueWorkerReadiness[];
  };
  flags: FlagReadiness;
  /** Hard problems that make `ok` false. */
  blockers: string[];
  /** Soft notes that don't block readiness but an operator should know. */
  warnings: string[];
};

function parsePerShopAllow(): number[] {
  const raw = process.env[PER_SHOP_FLAG_ENV] || "";
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const n = parseInt(part.trim(), 10);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

async function probeRedis(): Promise<RedisReadiness> {
  const urlSet = isQueueEnabled();
  if (!urlSet) {
    return { urlSet: false, reachable: false, pingMs: null, error: null };
  }
  const conn = getRedisConnection();
  if (!conn) {
    return {
      urlSet: true,
      reachable: false,
      pingMs: null,
      error: "Redis client could not be constructed",
    };
  }
  const start = Date.now();
  try {
    const pong = await Promise.race([
      conn.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`ping timed out after ${PING_TIMEOUT_MS}ms`)),
          PING_TIMEOUT_MS,
        ),
      ),
    ]);
    if (pong !== "PONG") {
      return {
        urlSet: true,
        reachable: false,
        pingMs: Date.now() - start,
        error: `unexpected ping reply: ${String(pong)}`,
      };
    }
    return {
      urlSet: true,
      reachable: true,
      pingMs: Date.now() - start,
      error: null,
    };
  } catch (err: any) {
    return {
      urlSet: true,
      reachable: false,
      pingMs: Date.now() - start,
      error: String(err?.message || err),
    };
  }
}

async function probeWorkers(): Promise<QueueWorkerReadiness[]> {
  const out: QueueWorkerReadiness[] = [];
  for (const name of ALL_QUEUE_NAMES) {
    const q = getQueue(name);
    if (!q) {
      out.push({ name, workerCount: 0, error: "queue unavailable" });
      continue;
    }
    try {
      const workers = await q.getWorkers();
      out.push({ name, workerCount: workers.length, error: null });
    } catch (err: any) {
      out.push({
        name,
        workerCount: 0,
        error: String(err?.message || err),
      });
    }
  }
  return out;
}

function buildFlagReadiness(redisReachable: boolean): FlagReadiness {
  const killSwitch = process.env[KILL_SWITCH_ENV] === "true";
  const globalEnabled = process.env[GLOBAL_FLAG_ENV] === "true";
  const perShopAllow = parsePerShopAllow();

  let effectiveMode: FlagReadiness["effectiveMode"];
  if (killSwitch) effectiveMode = "kill_switch";
  else if (!redisReachable) effectiveMode = "redis_missing";
  else if (globalEnabled) effectiveMode = "fleet";
  else if (perShopAllow.length > 0) effectiveMode = "canary";
  else effectiveMode = "off";

  const decisions: FlagDecisionReport[] = [];
  for (const shopId of perShopAllow) {
    const d = decideQueueFor(shopId);
    decisions.push({
      shopId,
      label: `allowlisted shop ${shopId}`,
      useQueue: d.useQueue,
      reason: d.reason,
    });
  }
  const other = decideQueueFor(SAMPLE_OTHER_SHOP_ID);
  decisions.push({
    shopId: SAMPLE_OTHER_SHOP_ID,
    label: "any non-allowlisted shop",
    useQueue: other.useQueue,
    reason: other.reason,
  });

  return { killSwitch, globalEnabled, perShopAllow, effectiveMode, decisions };
}

export async function getQueueReadiness(): Promise<QueueReadiness> {
  const redis = await probeRedis();

  // Only probe workers when Redis is reachable — otherwise getWorkers()
  // just times out against the dead connection and adds noise.
  const perQueue = redis.reachable
    ? await probeWorkers()
    : ALL_QUEUE_NAMES.map((name) => ({
        name,
        workerCount: 0,
        error: redis.urlSet ? "redis unreachable" : "REDIS_URL not set",
      }));

  const totalConsuming = perQueue.reduce((acc, q) => acc + q.workerCount, 0);
  const allQueuesCovered =
    perQueue.length > 0 && perQueue.every((q) => q.workerCount > 0);

  const flags = buildFlagReadiness(redis.reachable);

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!redis.urlSet) {
    blockers.push(
      `${"REDIS_URL"} is not set on this service — the queue subsystem is dormant and every shop runs on the legacy in-process path.`,
    );
  } else if (!redis.reachable) {
    blockers.push(
      `Redis is configured but unreachable (${redis.error || "unknown error"}). Producers will fail-open to the legacy path and log per enqueue.`,
    );
  }

  if (redis.reachable) {
    if (totalConsuming === 0) {
      blockers.push(
        "No BullMQ workers are consuming any queue. Deploy/start the worker service (npm run worker) before routing a shop.",
      );
    } else {
      for (const q of perQueue) {
        if (q.workerCount === 0) {
          blockers.push(
            `Queue '${q.name}' has no consumer — jobs would sit in 'waiting' forever.`,
          );
        }
      }
    }
  }

  if (flags.killSwitch) {
    warnings.push(
      `Kill switch ${KILL_SWITCH_ENV}=true is ON — every shop is forced to the legacy path regardless of the other flags. Unset it before you expect routing.`,
    );
  } else if (redis.reachable && flags.effectiveMode === "off") {
    warnings.push(
      `No shops are routed to the queue yet. Set ${PER_SHOP_FLAG_ENV}=<ids> for a canary or ${GLOBAL_FLAG_ENV}=true for fleet-wide once this check is green.`,
    );
  }

  const ok = redis.reachable && allQueuesCovered;

  return {
    ok,
    generatedAt: new Date().toISOString(),
    redis,
    workers: { totalConsuming, allQueuesCovered, perQueue },
    flags,
    blockers,
    warnings,
  };
}
