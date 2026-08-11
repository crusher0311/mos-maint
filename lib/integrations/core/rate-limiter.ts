import { acquireDistributedRateLimitSlot } from '@/lib/api-usage-tracker';
import type { SMSProvider } from './types';

type ApiProvider = 'tekmetric' | 'carfax' | 'dataone' | 'openai' | 'protractor' | 'autoflow' | 'hovercode' | 'shopmonkey';

// Two-lane queue: 'interactive' (VHI requests, dashboard, anything a human
// is waiting on) drains before 'background' (full-page backfills, prefetch,
// cron sweeps). Without this split a 30-page backfill chunk parked 30
// requests in the queue and every VHI request waited ~6s behind them at the
// 5 RPS limit. With it, the backfill yields between calls so interactive
// traffic gets a slot within ~200ms.
export type RateLimitPriority = 'interactive' | 'background';

// Max time a 'background' request will wait for a local rate-limit slot before
// giving up with { acquired: false }. Background requests only get a slot when
// the interactive lane is empty (see `processNext`), so on a process saturated
// with interactive traffic (the web service: webhooks, VHI, extension) the
// background lane can starve indefinitely. Before this bound, the awaited
// Promise had no timeout — a starved backfill request never fired, never
// errored, never timed out (the per-request HTTP timeout only covers the fetch,
// not this pre-fetch wait), so a full-page backfill chunk would silently hang
// for the whole cron tick, persist no progress, bump no heartbeat, and get its
// stale lock stolen next tick — head-of-line-blocking the entire fleet. Bailing
// after this cap lets the caller back off cleanly: client.ts throws on
// !acquired, the backfill catches it, persists progress, and frees the lock so
// the next shop gets a turn. On the idle worker process the background lane
// flows in <1s, so this cap effectively never fires there.
const BACKGROUND_SLOT_MAX_WAIT_MS = (() => {
  const parsed = Number(process.env.RATE_LIMIT_BACKGROUND_MAX_WAIT_MS);
  // Guard against a missing/garbage/too-small override that would make
  // background requests bail almost immediately and stall all backfill.
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 30_000;
})();

// Keyed by provider or "provider#lane" — a dedicated credential lane (e.g.
// Tekmetric's background API key, task #1079) gets its own local pacer
// queue because per-key RPS budgets are independent.
const localQueues: Map<string, {
  lastRequestTime: number;
  interactiveQueue: (() => void)[];
  backgroundQueue: (() => void)[];
  isProcessing: boolean;
  rpsLimit: number;
}> = new Map();

function getLocalQueue(provider: string, rpsLimit: number = 5) {
  if (!localQueues.has(provider)) {
    localQueues.set(provider, {
      lastRequestTime: 0,
      interactiveQueue: [],
      backgroundQueue: [],
      isProcessing: false,
      rpsLimit,
    });
  }
  return localQueues.get(provider)!;
}

function processLocalQueue(provider: string): void {
  const state = getLocalQueue(provider);
  if (
    state.isProcessing ||
    (state.interactiveQueue.length === 0 && state.backgroundQueue.length === 0)
  ) {
    return;
  }
  state.isProcessing = true;

  const intervalMs = 1000 / state.rpsLimit;

  const processNext = () => {
    // Interactive always wins. A backfill background request only gets a
    // slot when the interactive queue is empty.
    const next =
      state.interactiveQueue.shift() ?? state.backgroundQueue.shift();
    if (!next) {
      state.isProcessing = false;
      return;
    }

    const now = Date.now();
    const timeSinceLastRequest = now - state.lastRequestTime;
    const waitTime = Math.max(0, intervalMs - timeSinceLastRequest);

    setTimeout(() => {
      state.lastRequestTime = Date.now();
      next();
      processNext();
    }, waitTime);
  };

  processNext();
}

export interface RateLimitResult {
  acquired: boolean;
  waitedMs?: number;
  circuitOpen?: boolean;
}

export async function acquireRateLimitSlot(
  provider: SMSProvider,
  localRpsLimit: number = 5,
  priority: RateLimitPriority = 'interactive',
  // Credential lane (task #1079): pass e.g. 'bg' when the request
  // authenticates on a dedicated secondary API key. The lane gets its own
  // local pacer queue AND its own distributed minute buckets / circuit
  // breaker ("tekmetric-bg:<minute>"), because per-key rate limits are
  // independent — sharing the base provider's buckets would make two keys
  // falsely contend and defeat the capacity isolation.
  lane?: string,
): Promise<RateLimitResult> {
  const apiProvider = provider as ApiProvider;
  const queueKey = lane ? `${provider}#${lane}` : provider;
  const distributed = await acquireDistributedRateLimitSlot(apiProvider, undefined, lane);

  if (!distributed.acquired) {
    if (distributed.circuitOpen) {
      console.warn(`[RateLimiter] ${provider}: Circuit breaker open`);
      return { acquired: false, circuitOpen: true };
    }
    console.warn(`[RateLimiter] ${provider}: Distributed rate limit not acquired after ${distributed.waitedMs}ms`);
    return { acquired: false, waitedMs: distributed.waitedMs };
  }

  const state = getLocalQueue(queueKey, localRpsLimit);
  const waitStartedAt = Date.now();
  const acquired = await new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The function the queue calls when this request wins a slot. Guarded so a
    // late slot-grant after a timeout (or a double-call) is a harmless no-op.
    const slot = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    if (priority === 'background') {
      state.backgroundQueue.push(slot);
      // Bounded wait: interactive always wins, so a background request can
      // starve forever on a busy process. Give up after the cap and let the
      // caller back off instead of hanging the whole backfill tick.
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Drop our resolver from the queue so a freed slot isn't spent on a
        // request that already gave up.
        const i = state.backgroundQueue.indexOf(slot);
        if (i !== -1) state.backgroundQueue.splice(i, 1);
        resolve(false);
      }, BACKGROUND_SLOT_MAX_WAIT_MS);
    } else {
      // Interactive callers are human-facing and always win the lane, so they
      // resolve promptly — keep the original unbounded wait for them.
      state.interactiveQueue.push(slot);
    }
    processLocalQueue(queueKey);
  });

  if (!acquired) {
    const waitedMs = Date.now() - waitStartedAt;
    console.warn(
      `[RateLimiter] ${provider}: background slot starved — gave up after ${waitedMs}ms (interactive lane stayed busy). Caller will back off.`,
    );
    return { acquired: false, waitedMs };
  }

  return { acquired: true };
}

export function createRateLimiter(provider: SMSProvider, localRpsLimit: number = 5) {
  return {
    acquire: (priority: RateLimitPriority = 'interactive') =>
      acquireRateLimitSlot(provider, localRpsLimit, priority),
  };
}
