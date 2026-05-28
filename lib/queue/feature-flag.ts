/**
 * Per-shop feature flag for routing backfill work through the BullMQ
 * worker queue (task #513) instead of the in-process cron path.
 *
 * Three layers (highest priority first):
 *   1. `BACKFILL_QUEUE_DISABLED=true` — emergency kill switch, forces
 *      every shop back to the in-process path even if the per-shop or
 *      global flag is on. This is the rollback escape hatch documented
 *      in `docs/runbooks/worker-queue-cutover.md`.
 *   2. `BACKFILL_QUEUE_SHOPS=<comma-separated shopIds>` — opt specific
 *      shops into the queue. Use during shadow / canary rollout.
 *   3. `BACKFILL_QUEUE_ENABLED=true` — fleet-wide opt-in. Set only
 *      AFTER a clean weekend on the per-shop opt-in list.
 *
 * Default: false. Until an operator flips one of these flags, every
 * backfill keeps running on the legacy in-process path. The scaffold
 * lands dormant and is safe to deploy before Redis is provisioned.
 *
 * Redis presence is also required — the flag is treated as off when
 * `REDIS_URL` is unset, regardless of the env knobs above. This avoids
 * a scenario where someone flips the flag on before the Redis add-on
 * is live and silently strands jobs (the producer would fail-open back
 * to the in-process path, but it would log a warning per enqueue and
 * fragment the operator's mental model).
 */

import { isQueueEnabled } from "./connection";

export const KILL_SWITCH_ENV = "BACKFILL_QUEUE_DISABLED";
export const GLOBAL_FLAG_ENV = "BACKFILL_QUEUE_ENABLED";
export const PER_SHOP_FLAG_ENV = "BACKFILL_QUEUE_SHOPS";

export type FlagDecision = {
  useQueue: boolean;
  reason:
    | "kill_switch"
    | "redis_missing"
    | "per_shop_allow"
    | "global_enabled"
    | "default_off";
};

function killSwitchActive(): boolean {
  return process.env[KILL_SWITCH_ENV] === "true";
}

function perShopAllowSet(): Set<number> {
  const raw = process.env[PER_SHOP_FLAG_ENV] || "";
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const n = parseInt(part.trim(), 10);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return out;
}

export function decideQueueFor(shopId: number): FlagDecision {
  if (killSwitchActive()) return { useQueue: false, reason: "kill_switch" };
  if (!isQueueEnabled()) return { useQueue: false, reason: "redis_missing" };
  if (perShopAllowSet().has(shopId))
    return { useQueue: true, reason: "per_shop_allow" };
  if (process.env[GLOBAL_FLAG_ENV] === "true")
    return { useQueue: true, reason: "global_enabled" };
  return { useQueue: false, reason: "default_off" };
}

export function shouldUseQueueForShop(shopId: number): boolean {
  return decideQueueFor(shopId).useQueue;
}
