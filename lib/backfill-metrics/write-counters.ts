import { AsyncLocalStorage } from "node:async_hooks";

export interface ChunkWriteCounters {
  mongoWrites: number;
  pgWrites: number;
  rateLimiterWaitsMs: number;
  rateLimiterTimeouts: number;
  rateLimiterFallbacks: number;
  retries: number;
}

function fresh(): ChunkWriteCounters {
  return {
    mongoWrites: 0,
    pgWrites: 0,
    rateLimiterWaitsMs: 0,
    rateLimiterTimeouts: 0,
    rateLimiterFallbacks: 0,
    retries: 0,
  };
}

const als = new AsyncLocalStorage<ChunkWriteCounters>();

export function withChunkWriteCounters<T>(fn: (counters: ChunkWriteCounters) => Promise<T>): Promise<T> {
  const counters = fresh();
  return als.run(counters, () => fn(counters));
}

export function currentChunkCounters(): ChunkWriteCounters | undefined {
  return als.getStore();
}

export function bumpMongoWrites(n = 1): void {
  const c = als.getStore();
  if (c) c.mongoWrites += n;
}

export function bumpPgWrites(n = 1): void {
  const c = als.getStore();
  if (c) c.pgWrites += n;
}

export function bumpRateLimiterWait(ms: number): void {
  const c = als.getStore();
  if (c && Number.isFinite(ms) && ms > 0) c.rateLimiterWaitsMs += ms;
}

export function bumpRateLimiterTimeout(): void {
  const c = als.getStore();
  if (c) c.rateLimiterTimeouts += 1;
}

export function bumpRateLimiterFallback(): void {
  const c = als.getStore();
  if (c) c.rateLimiterFallbacks += 1;
}

export function bumpRetries(n = 1): void {
  const c = als.getStore();
  if (c) c.retries += n;
}
