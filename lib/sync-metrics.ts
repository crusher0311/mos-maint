import { getDb } from "./mongo";
import {
  pgRecordSyncMetric,
  pgUpsertIngestionError,
  pgResolveIngestionError,
  pgListUnresolvedIngestionErrors,
  pgSyncMetricsAggregate,
} from "@/lib/db/repositories/wave1";

export interface SyncMetrics {
  workerType: "tekmetric-sync" | "protractor-sync" | "tekmetric-backfill" | "protractor-backfill";
  shopId?: number;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  success: boolean;
  error?: string;
  recordsProcessed?: number;
  recordsSkipped?: number;
  retryCount?: number;
}

export interface IngestionError {
  workerType: string;
  shopId?: number;
  entityType: "work_order" | "vehicle" | "customer" | "payment" | "inspection" | "recommendation";
  entityId: string;
  error: string;
  rawData?: any;
  createdAt: Date;
  retryCount: number;
  resolved: boolean;
}

export async function logSyncMetric(metric: SyncMetrics): Promise<void> {
  // Wave 1 dual-write: PG canonical (must succeed) + Mongo best-effort mirror.
  await pgRecordSyncMetric(metric);
  try {
    const db = await getDb();
    await db.collection("sync_metrics").insertOne({ ...metric, createdAt: new Date() });
  } catch (err) {
    console.error("[SyncMetrics] Mongo mirror failed (non-fatal):", err);
  }
}

export async function logIngestionError(
  error: Omit<IngestionError, "createdAt" | "retryCount" | "resolved">,
): Promise<void> {
  // PG canonical first; if it throws, the caller (a worker/retry loop) will
  // re-queue the error so we don't silently lose it.
  await pgUpsertIngestionError(error);
  try {
    const db = await getDb();
    await db.collection("ingestion_errors").updateOne(
      {
        workerType: error.workerType,
        entityType: error.entityType,
        entityId: error.entityId,
      },
      {
        $set: { ...error, updatedAt: new Date(), resolved: false },
        $inc: { retryCount: 1 },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  } catch (err) {
    console.error("[SyncMetrics] Mongo ingestion-error mirror failed (non-fatal):", err);
  }
}

export async function markIngestionErrorResolved(
  workerType: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  // PG canonical first.
  await pgResolveIngestionError(workerType, entityType, entityId);
  try {
    const db = await getDb();
    await db.collection("ingestion_errors").updateOne(
      { workerType, entityType, entityId },
      { $set: { resolved: true, resolvedAt: new Date() } },
    );
  } catch (err) {
    console.error("[SyncMetrics] Mongo resolve mirror failed (non-fatal):", err);
  }
}

export async function getUnresolvedErrors(
  workerType?: string,
  limit = 100,
): Promise<IngestionError[]> {
  // Wave 1: read from PG.
  try {
    const rows = await pgListUnresolvedIngestionErrors(workerType, limit);
    return rows.map((r) => ({
      workerType: r.workerType,
      shopId: r.shopId ?? undefined,
      entityType: r.entityType as IngestionError["entityType"],
      entityId: r.entityId,
      error: r.error,
      rawData: r.rawData,
      createdAt: r.createdAt,
      retryCount: r.retryCount,
      resolved: r.resolved,
    }));
  } catch (err) {
    console.error("[SyncMetrics] PG read failed:", err);
    return [];
  }
}

export async function getSyncStats(
  workerType: string,
  hours = 24,
): Promise<{
  total: number;
  successful: number;
  failed: number;
  avgDurationMs: number;
}> {
  try {
    const sinceDays = Math.max(1, Math.ceil(hours / 24));
    const rows = await pgSyncMetricsAggregate(workerType, sinceDays);
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const filtered = rows.filter((r) => new Date(r.createdAt).getTime() >= cutoff);
    const total = filtered.length;
    const successful = filtered.filter((r) => r.success).length;
    const failed = total - successful;
    const durations = filtered
      .map((r) => r.durationMs)
      .filter((x): x is number => typeof x === "number");
    const avgDurationMs = durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;
    return { total, successful, failed, avgDurationMs };
  } catch (err) {
    console.error("[SyncMetrics] PG sync-stats read failed:", err);
    return { total: 0, successful: 0, failed: 0, avgDurationMs: 0 };
  }
}
