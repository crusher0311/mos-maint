import { acquireDistributedRateLimitSlot } from '@/lib/api-usage-tracker';
import type { SMSProvider } from './types';

type ApiProvider = 'tekmetric' | 'carfax' | 'dataone' | 'openai' | 'protractor' | 'autoflow' | 'hovercode';

const localQueues: Map<SMSProvider, {
  lastRequestTime: number;
  queue: (() => void)[];
  isProcessing: boolean;
  rpsLimit: number;
}> = new Map();

function getLocalQueue(provider: SMSProvider, rpsLimit: number = 5) {
  if (!localQueues.has(provider)) {
    localQueues.set(provider, {
      lastRequestTime: 0,
      queue: [],
      isProcessing: false,
      rpsLimit,
    });
  }
  return localQueues.get(provider)!;
}

function processLocalQueue(provider: SMSProvider): void {
  const state = getLocalQueue(provider);
  if (state.isProcessing || state.queue.length === 0) return;
  state.isProcessing = true;
  
  const intervalMs = 1000 / state.rpsLimit;
  
  const processNext = () => {
    if (state.queue.length === 0) {
      state.isProcessing = false;
      return;
    }
    
    const now = Date.now();
    const timeSinceLastRequest = now - state.lastRequestTime;
    const waitTime = Math.max(0, intervalMs - timeSinceLastRequest);
    
    setTimeout(() => {
      state.lastRequestTime = Date.now();
      const resolve = state.queue.shift();
      if (resolve) resolve();
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
  localRpsLimit: number = 5
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
    state.queue.push(resolve);
    processLocalQueue(provider);
  });
  
  return { acquired: true };
}

export function createRateLimiter(provider: SMSProvider, localRpsLimit: number = 5) {
  return {
    acquire: () => acquireRateLimitSlot(provider, localRpsLimit),
  };
}
