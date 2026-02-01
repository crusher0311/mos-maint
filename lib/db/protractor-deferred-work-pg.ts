import sql from "@/lib/db/postgres";

export interface ProtractorDeferredWork {
  id: string;
  shop_id: string | null;
  external_shop_id: number;
  work_order_id: string | null;
  vin: string | null;
  deferred_items: unknown[];
  status: string;
  created_at: Date;
  processed_at: Date | null;
}

export async function upsertProtractorDeferredWork(
  shopUUID: string | null,
  externalShopId: number,
  vin: string,
  items: unknown[]
): Promise<ProtractorDeferredWork> {
  const now = new Date();
  const normalizedVin = vin.toUpperCase().trim();
  
  const existing = await sql<ProtractorDeferredWork[]>`
    SELECT * FROM protractor_deferred_work
    WHERE external_shop_id = ${externalShopId} AND vin = ${normalizedVin}
    LIMIT 1
  `;
  
  if (existing[0]) {
    await sql`
      UPDATE protractor_deferred_work
      SET deferred_items = ${JSON.stringify(items)}::jsonb,
          created_at = ${now}
      WHERE id = ${existing[0].id}
    `;
    return { ...existing[0], deferred_items: items, created_at: now };
  }
  
  const results = await sql<ProtractorDeferredWork[]>`
    INSERT INTO protractor_deferred_work (
      id, shop_id, external_shop_id, vin, deferred_items, status, created_at
    ) VALUES (
      gen_random_uuid(),
      ${shopUUID},
      ${externalShopId},
      ${normalizedVin},
      ${JSON.stringify(items)}::jsonb,
      'pending',
      ${now}
    )
    RETURNING *
  `;
  
  return results[0];
}

export async function getProtractorDeferredWorkByVin(
  externalShopId: number,
  vin: string
): Promise<ProtractorDeferredWork | null> {
  const normalizedVin = vin.toUpperCase().trim();
  const results = await sql<ProtractorDeferredWork[]>`
    SELECT * FROM protractor_deferred_work
    WHERE external_shop_id = ${externalShopId} AND vin = ${normalizedVin}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return results[0] || null;
}

export async function getProtractorDeferredWorkForShop(
  externalShopId: number,
  limit = 100
): Promise<ProtractorDeferredWork[]> {
  return sql<ProtractorDeferredWork[]>`
    SELECT * FROM protractor_deferred_work
    WHERE external_shop_id = ${externalShopId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

export async function markProtractorDeferredWorkProcessed(
  id: string
): Promise<void> {
  await sql`
    UPDATE protractor_deferred_work
    SET status = 'processed', processed_at = NOW()
    WHERE id = ${id}
  `;
}
