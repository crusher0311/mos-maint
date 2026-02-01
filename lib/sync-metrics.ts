import sql from "@/lib/db/postgres";

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
  rawData?: Record<string, unknown>;
  createdAt: Date;
  retryCount: number;
  resolved: boolean;
}

export async function logSyncMetric(metric: SyncMetrics): Promise<void> {
  try {
    const shopIdStr = metric.shopId ? String(metric.shopId) : null;
    const provider = metric.workerType.split("-")[0];
    const syncType = metric.workerType.includes("backfill") ? "backfill" : "incremental";
    
    await sql`
      INSERT INTO sync_metrics (shop_id, provider, sync_type, records_synced, duration_ms, errors, error_details, started_at, completed_at)
      VALUES (
        ${shopIdStr ? sql`(SELECT id FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1)` : sql`NULL`},
        ${provider},
        ${syncType},
        ${metric.recordsProcessed || 0},
        ${metric.durationMs || 0},
        ${metric.success ? 0 : 1},
        ${metric.error ? JSON.stringify({ message: metric.error }) : null}::jsonb,
        ${metric.startedAt},
        ${metric.completedAt || null}
      )
    `;
  } catch (err) {
    console.error("[SyncMetrics] Failed to log metric:", err);
  }
}

export async function logIngestionError(error: Omit<IngestionError, "createdAt" | "retryCount" | "resolved">): Promise<void> {
  try {
    const shopIdStr = error.shopId ? String(error.shopId) : null;
    
    await sql`
      INSERT INTO ingestion_errors (shop_id, source, entity_type, entity_id, error_type, error_message, raw_data)
      VALUES (
        ${shopIdStr ? sql`(SELECT id FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1)` : sql`NULL`},
        ${error.workerType},
        ${error.entityType},
        ${error.entityId},
        'ingestion_error',
        ${error.error},
        ${error.rawData ? JSON.stringify(error.rawData) : null}::jsonb
      )
      ON CONFLICT (source, entity_type, entity_id) WHERE source IS NOT NULL
      DO UPDATE SET
        error_message = EXCLUDED.error_message,
        raw_data = EXCLUDED.raw_data
    `;
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
    await sql`
      DELETE FROM ingestion_errors
      WHERE source = ${workerType}
        AND entity_type = ${entityType}
        AND entity_id = ${entityId}
    `;
  } catch (err) {
    console.error("[SyncMetrics] Failed to mark error resolved:", err);
  }
}

export async function getUnresolvedErrors(workerType?: string, limit = 100): Promise<IngestionError[]> {
  try {
    const rows = workerType
      ? await sql`
          SELECT source as worker_type, shop_id, entity_type, entity_id, error_message as error, raw_data, created_at
          FROM ingestion_errors
          WHERE source = ${workerType}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT source as worker_type, shop_id, entity_type, entity_id, error_message as error, raw_data, created_at
          FROM ingestion_errors
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
    
    return rows.map(row => ({
      workerType: row.worker_type as string,
      shopId: undefined,
      entityType: row.entity_type as IngestionError["entityType"],
      entityId: row.entity_id as string,
      error: row.error as string,
      rawData: row.raw_data as Record<string, unknown>,
      createdAt: new Date(row.created_at as string),
      retryCount: 0,
      resolved: false,
    }));
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
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const provider = workerType.split("-")[0];
    const syncType = workerType.includes("backfill") ? "backfill" : "incremental";
    
    const rows = await sql`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN errors = 0 THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN errors > 0 THEN 1 ELSE 0 END) as failed,
        AVG(duration_ms) as avg_duration_ms
      FROM sync_metrics
      WHERE provider = ${provider}
        AND sync_type = ${syncType}
        AND created_at >= ${since}
    `;
    
    const result = rows[0] || {};
    return {
      total: Number(result.total || 0),
      successful: Number(result.successful || 0),
      failed: Number(result.failed || 0),
      avgDurationMs: Number(result.avg_duration_ms || 0),
    };
  } catch (err) {
    console.error("[SyncMetrics] Failed to get sync stats:", err);
    return { total: 0, successful: 0, failed: 0, avgDurationMs: 0 };
  }
}
