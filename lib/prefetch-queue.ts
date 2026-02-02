import sql from '@/lib/db/postgres';

export interface PrefetchQueueItem {
  id: string;
  shop_id: string;
  vin: string;
  priority: number;
  source: string;
  enqueued_at: Date;
  metadata: Record<string, unknown> | null;
}

export const PREFETCH_PRIORITY = {
  IN_PROGRESS_RO: 100,
  WEBHOOK_UPDATE: 90,
  RECENT_VIEW: 80,
  SCHEDULED_APPOINTMENT: 70,
  RECENTLY_UPDATED: 60,
  BACKGROUND: 50,
} as const;

export async function enqueuePrefetch(
  shopId: string,
  vin: string,
  priority: number,
  source: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await sql`
    INSERT INTO prefetch_queue (shop_id, vin, priority, source, metadata)
    VALUES (${shopId}, ${vin.toUpperCase()}, ${priority}, ${source}, ${metadata ? JSON.stringify(metadata) : null}::jsonb)
    ON CONFLICT (shop_id, vin) DO UPDATE SET
      priority = GREATEST(prefetch_queue.priority, EXCLUDED.priority),
      source = EXCLUDED.source,
      enqueued_at = NOW(),
      metadata = COALESCE(EXCLUDED.metadata, prefetch_queue.metadata),
      completed_at = NULL,
      error = NULL
    WHERE prefetch_queue.completed_at IS NOT NULL
       OR prefetch_queue.priority < EXCLUDED.priority
  `;
}

export async function enqueueBatchPrefetch(
  items: Array<{ shopId: string; vin: string; priority: number; source: string; metadata?: Record<string, unknown> }>
): Promise<void> {
  if (items.length === 0) return;
  
  for (const item of items) {
    await enqueuePrefetch(item.shopId, item.vin, item.priority, item.source, item.metadata);
  }
}

export async function getNextPrefetchBatch(limit: number = 10): Promise<PrefetchQueueItem[]> {
  const items = await sql<PrefetchQueueItem[]>`
    UPDATE prefetch_queue
    SET processing_started_at = NOW()
    WHERE id IN (
      SELECT id FROM prefetch_queue
      WHERE completed_at IS NULL
        AND processing_started_at IS NULL
      ORDER BY priority DESC, enqueued_at ASC
      LIMIT ${limit}
    )
    RETURNING id, shop_id, vin, priority, source, enqueued_at, metadata
  `;
  return items;
}

export async function markPrefetchComplete(id: string, error?: string): Promise<void> {
  await sql`
    UPDATE prefetch_queue
    SET completed_at = NOW(), error = ${error || null}
    WHERE id = ${id}
  `;
}

export async function resetStalePrefetchItems(staleMinutes: number = 10): Promise<number> {
  const result = await sql`
    UPDATE prefetch_queue
    SET processing_started_at = NULL
    WHERE processing_started_at IS NOT NULL
      AND completed_at IS NULL
      AND processing_started_at < NOW() - INTERVAL '${staleMinutes} minutes'
  `;
  return result.count;
}

export async function queueInProgressROVehicles(shopId: string): Promise<number> {
  const inProgressVehicles = await sql`
    SELECT DISTINCT v.vin
    FROM work_orders wo
    JOIN vehicles v ON wo.vehicle_id = v.id
    WHERE wo.shop_id = ${shopId}::uuid
      AND wo.status IN ('In Progress', 'Waiting', 'Open')
      AND v.vin IS NOT NULL
    LIMIT 50
  `;
  
  for (const row of inProgressVehicles) {
    await enqueuePrefetch(shopId, row.vin, PREFETCH_PRIORITY.IN_PROGRESS_RO, 'in_progress_ro');
  }
  
  return inProgressVehicles.length;
}

export async function queueRecentlyViewedVehicles(shopId: string, hours: number = 24): Promise<number> {
  const viewedVehicles = await sql`
    SELECT DISTINCT vin
    FROM viewed_vins
    WHERE shop_id = ${shopId}
      AND viewed_at > NOW() - INTERVAL '${hours} hours'
    ORDER BY viewed_at DESC
    LIMIT 50
  `;
  
  for (const row of viewedVehicles) {
    await enqueuePrefetch(shopId, row.vin, PREFETCH_PRIORITY.RECENT_VIEW, 'recent_view');
  }
  
  return viewedVehicles.length;
}

export async function queueRecentlyUpdatedVehicles(shopId: string, hours: number = 4): Promise<number> {
  const updatedVehicles = await sql`
    SELECT DISTINCT vin
    FROM vehicles
    WHERE shop_id = ${shopId}::uuid
      AND updated_at > NOW() - INTERVAL '${hours} hours'
      AND vin IS NOT NULL
    LIMIT 50
  `;
  
  for (const row of updatedVehicles) {
    await enqueuePrefetch(shopId, row.vin, PREFETCH_PRIORITY.RECENTLY_UPDATED, 'recently_updated');
  }
  
  return updatedVehicles.length;
}

export async function getPrefetchQueueStats(): Promise<{
  pending: number;
  processing: number;
  completed_today: number;
  errors_today: number;
}> {
  const stats = await sql`
    SELECT
      COUNT(*) FILTER (WHERE completed_at IS NULL AND processing_started_at IS NULL) as pending,
      COUNT(*) FILTER (WHERE completed_at IS NULL AND processing_started_at IS NOT NULL) as processing,
      COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND completed_at > NOW() - INTERVAL '1 day' AND error IS NULL) as completed_today,
      COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND completed_at > NOW() - INTERVAL '1 day' AND error IS NOT NULL) as errors_today
    FROM prefetch_queue
  `;
  return {
    pending: Number(stats[0]?.pending || 0),
    processing: Number(stats[0]?.processing || 0),
    completed_today: Number(stats[0]?.completed_today || 0),
    errors_today: Number(stats[0]?.errors_today || 0),
  };
}

export async function cleanupOldPrefetchItems(daysOld: number = 7): Promise<number> {
  const result = await sql`
    DELETE FROM prefetch_queue
    WHERE completed_at IS NOT NULL
      AND completed_at < NOW() - INTERVAL '${daysOld} days'
  `;
  return result.count;
}
