import type { Db } from "mongodb";
import { getDb } from "@/lib/mongo";
import type { ChunkWriteCounters } from "./write-counters";

export const BACKFILL_CHUNK_METRICS_COLLECTION = "backfill_chunk_metrics";
const TTL_SECONDS = 30 * 24 * 60 * 60;

export type BackfillProvider =
  | "tekmetric"
  | "tekmetric-fullpage"
  | "protractor"
  | "shopware";

export interface BackfillChunkMetric {
  provider: BackfillProvider;
  shopId: number | string;
  chunkStartedAt: Date;
  chunkEndedAt: Date;
  durationMs: number;
  pagesProcessed?: number;
  rosProcessed?: number;
  outcome: "ok" | "error" | "deferred" | "complete" | "empty";
  message?: string;
  backoffMs?: number;
  writes: ChunkWriteCounters;
  extras?: Record<string, unknown>;
  createdAt: Date;
}

let indexEnsured = false;

async function ensureIndex(db: Db): Promise<void> {
  if (indexEnsured) return;
  try {
    const col = db.collection(BACKFILL_CHUNK_METRICS_COLLECTION);
    await col.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: TTL_SECONDS, name: "createdAt_ttl_30d" },
    );
    await col.createIndex(
      { provider: 1, chunkEndedAt: -1 },
      { name: "provider_chunkEndedAt" },
    );
    await col.createIndex(
      { provider: 1, shopId: 1, chunkEndedAt: -1 },
      { name: "provider_shop_chunkEndedAt" },
    );
    indexEnsured = true;
  } catch (err: any) {
    console.warn(
      `[BackfillMetrics] failed to ensure indexes on ${BACKFILL_CHUNK_METRICS_COLLECTION}: ${err?.message || err}`,
    );
  }
}

export interface RecordChunkMetricInput {
  provider: BackfillProvider;
  shopId: number | string;
  chunkStartedAt: number | Date;
  pagesProcessed?: number;
  rosProcessed?: number;
  outcome: BackfillChunkMetric["outcome"];
  message?: string;
  backoffMs?: number;
  counters: ChunkWriteCounters;
  extras?: Record<string, unknown>;
}

export async function recordChunkMetric(input: RecordChunkMetricInput): Promise<void> {
  const startedAt =
    input.chunkStartedAt instanceof Date
      ? input.chunkStartedAt
      : new Date(input.chunkStartedAt);
  const endedAt = new Date();
  const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());

  const doc: BackfillChunkMetric = {
    provider: input.provider,
    shopId: input.shopId,
    chunkStartedAt: startedAt,
    chunkEndedAt: endedAt,
    durationMs,
    pagesProcessed: input.pagesProcessed,
    rosProcessed: input.rosProcessed,
    outcome: input.outcome,
    message: input.message,
    backoffMs: input.backoffMs,
    writes: { ...input.counters },
    extras: input.extras,
    createdAt: endedAt,
  };

  // Structured Better Stack log line. Single-line JSON makes it trivial to
  // build queries off of in the Better Stack UI without parsing free text.
  try {
    console.log(
      "[BackfillChunkMetric] " +
        JSON.stringify({
          provider: doc.provider,
          shopId: doc.shopId,
          durationMs: doc.durationMs,
          rosProcessed: doc.rosProcessed ?? null,
          pagesProcessed: doc.pagesProcessed ?? null,
          outcome: doc.outcome,
          backoffMs: doc.backoffMs ?? null,
          mongoWrites: doc.writes.mongoWrites,
          pgWrites: doc.writes.pgWrites,
          rateLimiterWaitsMs: doc.writes.rateLimiterWaitsMs,
          rateLimiterTimeouts: doc.writes.rateLimiterTimeouts,
          rateLimiterFallbacks: doc.writes.rateLimiterFallbacks,
          retries: doc.writes.retries,
        }),
    );
  } catch {}

  try {
    const db = await getDb();
    await ensureIndex(db);
    await db.collection(BACKFILL_CHUNK_METRICS_COLLECTION).insertOne(doc as any);
  } catch (err: any) {
    // Metrics are observability — never break a chunk because we couldn't
    // record one. The structured log line above is the durable signal.
    console.warn(
      `[BackfillMetrics] insert failed for ${input.provider}/${input.shopId}: ${err?.message || err}`,
    );
  }
}
