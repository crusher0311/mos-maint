import { acquireDistributedRateLimitSlot } from '@/lib/api-usage-tracker';
import type { SMSProvider } from './types';

type ApiProvider = 'tekmetric' | 'carfax' | 'dataone' | 'openai' | 'protractor' | 'autoflow' | 'hovercode';

// Two-lane queue: 'interactive' (VHI requests, dashboard, anything a human
// is waiting on) drains before 'background' (full-page backfills, prefetch,
// cron sweeps). Without this split a 30-page backfill chunk parked 30
// requests in the queue and every VHI request waited ~6s behind them at the
// 5 RPS limit. With it, the backfill yields between calls so interactive
// traffic gets a slot within ~200ms.
export type RateLimitPriority = 'interactive' | 'background';

const localQueues: Map<SMSProvider, {
  lastRequestTime: number;
  interactiveQueue: (() => void)[];
  backgroundQueue: (() => void)[];
  isProcessing: boolean;
  rpsLimit: number;
}> = new Map();

function getLocalQueue(provider: SMSProvider, rpsLimit: number = 5) {
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

function processLocalQueue(provider: SMSProvider): void {
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
): Promise<RateLimitResult> {
  const apiProvider = provider as ApiProvider;
  const distributed = await acquireDistributedRateLimitSlot(apiProvider);

  if (!distributed.acquired) {
    if (distributed.circuitOpen) {
      console.warn(`[RateLimiter] ${provider}: Circuit breaker open`);
      return { acquired: false, circuitOpen: true };
    }
    console.warn(`[RateLimiter] ${provider}: Distributed rate limit not acquired after ${distributed.waitedMs}ms`);
    return { acquired: false, waitedMs: distributed.waitedMs };
  }

  const state = getLocalQueue(provider, localRpsLimit);
  await new Promise<void>((resolve) => {
    if (priority === 'background') {
      state.backgroundQueue.push(resolve);
    } else {
      state.interactiveQueue.push(resolve);
    }
    processLocalQueue(provider);
  });

  return { acquired: true };
}

export function createRateLimiter(provider: SMSProvider, localRpsLimit: number = 5) {
  return {
    acquire: (priority: RateLimitPriority = 'interactive') =>
      acquireRateLimitSlot(provider, localRpsLimit, priority),
  };
}
