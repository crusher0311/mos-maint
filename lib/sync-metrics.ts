import { getDb } from "./mongo";

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
  try {
    const db = await getDb();
    await db.collection("sync_metrics").insertOne({
      ...metric,
      createdAt: new Date()
    });
  } catch (err) {
    console.error("[SyncMetrics] Failed to log metric:", err);
  }
}

export async function logIngestionError(error: Omit<IngestionError, "createdAt" | "retryCount" | "resolved">): Promise<void> {
  try {
    const db = await getDb();
    await db.collection("ingestion_errors").updateOne(
      { 
        workerType: error.workerType, 
        entityType: error.entityType, 
        entityId: error.entityId 
      },
      {
        $set: {
          ...error,
          updatedAt: new Date(),
          resolved: false
        },
        $inc: { retryCount: 1 },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("[SyncMetrics] Failed to log ingestion error:", err);
  }
}

export async function markIngestionErrorResolved(
  workerType: string,
  entityType: string,
  entityId: string
): Promise<void> {
  try {
    const db = await getDb();
    await db.collection("ingestion_errors").updateOne(
      { workerType, entityType, entityId },
      { $set: { resolved: true, resolvedAt: new Date() } }
    );
  } catch (err) {
    console.error("[SyncMetrics] Failed to mark error resolved:", err);
  }
}

export async function getUnresolvedErrors(workerType?: string, limit = 100): Promise<IngestionError[]> {
  try {
    const db = await getDb();
    const query: any = { resolved: false };
    if (workerType) query.workerType = workerType;
    
    const docs = await db.collection("ingestion_errors")
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    
    return docs as unknown as IngestionError[];
  } catch (err) {
    console.error("[SyncMetrics] Failed to get unresolved errors:", err);
    return [];
  }
}

export async function getSyncStats(workerType: string, hours = 24): Promise<{
  total: number;
  successful: number;
  failed: number;
  avgDurationMs: number;
}> {
  try {
    const db = await getDb();
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    const stats = await db.collection("sync_metrics").aggregate([
      { $match: { workerType, createdAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          successful: { $sum: { $cond: ["$success", 1, 0] } },
          failed: { $sum: { $cond: ["$success", 0, 1] } },
          avgDurationMs: { $avg: "$durationMs" }
        }
      }
    ]).toArray();
    
    const result = stats[0] as { total?: number; successful?: number; failed?: number; avgDurationMs?: number } | undefined;
    return { 
      total: result?.total || 0, 
      successful: result?.successful || 0, 
      failed: result?.failed || 0, 
      avgDurationMs: result?.avgDurationMs || 0 
    };
  } catch (err) {
    console.error("[SyncMetrics] Failed to get sync stats:", err);
    return { total: 0, successful: 0, failed: 0, avgDurationMs: 0 };
  }
}
