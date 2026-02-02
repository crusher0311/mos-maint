import sql from '@/lib/db/postgres';

export interface HotStartStatus {
  shopId: string;
  hotStartCompleted: boolean;
  hotStartStartedAt: Date | null;
  hotStartCompletedAt: Date | null;
}

export async function getHotStartStatus(shopId: string): Promise<HotStartStatus | null> {
  const rows = await sql`
    SELECT id, hot_start_completed, hot_start_started_at, hot_start_completed_at
    FROM shops
    WHERE shop_id = ${shopId}
    LIMIT 1
  `;
  
  if (!rows[0]) return null;
  
  const shop = rows[0] as any;
  return {
    shopId,
    hotStartCompleted: shop.hot_start_completed || false,
    hotStartStartedAt: shop.hot_start_started_at ? new Date(shop.hot_start_started_at) : null,
    hotStartCompletedAt: shop.hot_start_completed_at ? new Date(shop.hot_start_completed_at) : null,
  };
}

export async function startHotStart(shopId: string): Promise<void> {
  await sql`
    UPDATE shops
    SET hot_start_started_at = NOW(),
        hot_start_completed = FALSE,
        updated_at = NOW()
    WHERE shop_id = ${shopId}
  `;
}

export async function completeHotStart(shopId: string): Promise<void> {
  await sql`
    UPDATE shops
    SET hot_start_completed = TRUE,
        hot_start_completed_at = NOW(),
        updated_at = NOW()
    WHERE shop_id = ${shopId}
  `;
  console.log(`[HotStart] Completed hot-start for shop ${shopId}`);
}

export async function getShopsNeedingHotStart(): Promise<{ shopId: string; name: string; integration: string }[]> {
  const shops = await sql`
    SELECT shop_id, name, 
           CASE 
             WHEN tekmetric->>'shopId' IS NOT NULL THEN 'tekmetric'
             WHEN protractor->>'enabled' = 'true' THEN 'protractor'
             ELSE 'unknown'
           END as integration
    FROM shops
    WHERE is_active = true
      AND (hot_start_completed IS NULL OR hot_start_completed = FALSE)
      AND (
        tekmetric->>'shopId' IS NOT NULL
        OR protractor->>'enabled' = 'true'
      )
    ORDER BY created_at DESC
  `;
  
  return (shops as any[]).map(s => ({
    shopId: s.shop_id,
    name: s.name,
    integration: s.integration,
  }));
}

export function getHotStartDateRange(): { startDate: Date; endDate: Date } {
  const endDate = new Date();
  endDate.setHours(23, 59, 59, 999);
  
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);
  startDate.setHours(0, 0, 0, 0);
  
  return { startDate, endDate };
}

export async function updateBackfillProgressPhase(
  externalShopId: number,
  entityType: string,
  phase: 'hot_start' | 'historical'
): Promise<void> {
  await sql`
    UPDATE tekmetric_backfill_progress
    SET phase = ${phase},
        updated_at = NOW()
    WHERE external_shop_id = ${externalShopId}
      AND entity_type = ${entityType}
  `;
}

export async function isHotStartPhaseComplete(
  externalShopId: number,
  entityType: string
): Promise<boolean> {
  const rows = await sql`
    SELECT phase, status
    FROM tekmetric_backfill_progress
    WHERE external_shop_id = ${externalShopId}
      AND entity_type = ${entityType}
    LIMIT 1
  `;
  
  if (!rows[0]) return false;
  
  const progress = rows[0] as any;
  return progress.phase === 'historical' || progress.status === 'completed';
}
