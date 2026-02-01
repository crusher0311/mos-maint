import sql from "@/lib/db/postgres";

export interface Shop {
  id: string;
  name: string | null;
  slug: string | null;
  owner_id: string | null;
  settings: Record<string, unknown> | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  shop_id: string | null;
  webhook_token: string | null;
  branding: Record<string, unknown> | null;
  location_identifier: string | null;
  enterprise_id: string | null;
  billing: Record<string, unknown> | null;
  autoflow: Record<string, unknown> | null;
  autovitals: Record<string, unknown> | null;
  protractor: Record<string, unknown> | null;
  tekmetric: Record<string, unknown> | null;
  carfax: Record<string, unknown> | null;
  sticker_config: Record<string, unknown> | null;
}

export async function getShopById(id: string): Promise<Shop | null> {
  const shops = await sql<Shop[]>`
    SELECT * FROM shops WHERE id = ${id} LIMIT 1
  `;
  return shops[0] || null;
}

export async function getShopByShopId(shopId: number | string): Promise<Shop | null> {
  const shopIdStr = String(shopId);
  const shops = await sql<Shop[]>`
    SELECT * FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1
  `;
  return shops[0] || null;
}

export async function getShopBySlug(slug: string): Promise<Shop | null> {
  const shops = await sql<Shop[]>`
    SELECT * FROM shops WHERE slug = ${slug} LIMIT 1
  `;
  return shops[0] || null;
}

export async function getShopsByOwnerId(ownerId: string): Promise<Shop[]> {
  return sql<Shop[]>`
    SELECT * FROM shops WHERE owner_id = ${ownerId} ORDER BY name
  `;
}

export async function getAllActiveShops(): Promise<Shop[]> {
  return sql<Shop[]>`
    SELECT * FROM shops WHERE is_active = true ORDER BY name
  `;
}

export async function getTekmetricEnabledShops(): Promise<Shop[]> {
  return sql<Shop[]>`
    SELECT * FROM shops 
    WHERE is_active = true 
    AND tekmetric IS NOT NULL 
    AND tekmetric->>'shopId' IS NOT NULL
    ORDER BY name
  `;
}

export async function getProtractorEnabledShops(): Promise<Shop[]> {
  return sql<Shop[]>`
    SELECT * FROM shops 
    WHERE is_active = true 
    AND protractor IS NOT NULL 
    AND protractor->>'enabled' = 'true'
    ORDER BY name
  `;
}

export async function updateShopTekmetricConfig(
  shopId: string,
  tekmetricConfig: Record<string, unknown>
): Promise<void> {
  await sql`
    UPDATE shops 
    SET tekmetric = ${JSON.stringify(tekmetricConfig)}::jsonb,
        updated_at = NOW()
    WHERE id = ${shopId}
  `;
}

export async function updateShopTekmetricSyncState(
  shopIntId: number | string,
  updates: {
    lastSyncCursor?: Date | null;
    overflowQueue?: unknown[];
    lastClosedSweepAt?: Date | null;
    consecutiveAuthFailures?: number;
    pausedUntil?: Date | null;
    lastSync?: Date;
  }
): Promise<void> {
  const shopIdStr = String(shopIntId);
  
  const shop = await getShopByShopId(shopIntId);
  if (!shop) return;
  
  const existingTekmetric = (shop.tekmetric || {}) as Record<string, unknown>;
  const updatedTekmetric = {
    ...existingTekmetric,
    ...updates,
    lastSync: updates.lastSync || new Date()
  };
  
  await sql`
    UPDATE shops 
    SET tekmetric = ${JSON.stringify(updatedTekmetric)}::jsonb,
        updated_at = NOW()
    WHERE shop_id = ${shopIdStr}
  `;
}

export async function getShopTekmetricState(shopIntId: number | string): Promise<{
  shopId: number;
  tekmetricShopId: number | null;
  lastSyncCursor: Date | null;
  overflowQueue: unknown[];
  lastClosedSweepAt: Date | null;
  consecutiveAuthFailures: number;
  pausedUntil: Date | null;
} | null> {
  const shop = await getShopByShopId(shopIntId);
  if (!shop) return null;
  
  const tekmetric = (shop.tekmetric || {}) as Record<string, unknown>;
  const tekmetricShopId = tekmetric.shopId as number | undefined;
  
  if (!tekmetricShopId) return null;
  
  return {
    shopId: Number(shop.shop_id),
    tekmetricShopId: Number(tekmetricShopId),
    lastSyncCursor: tekmetric.lastSyncCursor ? new Date(tekmetric.lastSyncCursor as string) : null,
    overflowQueue: (tekmetric.overflowQueue as unknown[]) || [],
    lastClosedSweepAt: tekmetric.lastClosedSweepAt ? new Date(tekmetric.lastClosedSweepAt as string) : null,
    consecutiveAuthFailures: (tekmetric.consecutiveAuthFailures as number) || 0,
    pausedUntil: tekmetric.pausedUntil ? new Date(tekmetric.pausedUntil as string) : null,
  };
}

export async function upsertShop(
  data: {
    name: string;
    slug?: string | null;
    ownerId?: string | null;
    shopId?: number | string | null;
    settings?: Record<string, unknown> | null;
    branding?: Record<string, unknown> | null;
    billing?: Record<string, unknown> | null;
    tekmetric?: Record<string, unknown> | null;
    protractor?: Record<string, unknown> | null;
    autoflow?: Record<string, unknown> | null;
    autovitals?: Record<string, unknown> | null;
    carfax?: Record<string, unknown> | null;
    enterpriseId?: string | null;
    isActive?: boolean;
  }
): Promise<Shop> {
  const now = new Date();
  const shopIdStr = data.shopId ? String(data.shopId) : null;
  
  const shops = await sql<Shop[]>`
    INSERT INTO shops (
      id, name, slug, owner_id, shop_id, settings, branding, billing,
      tekmetric, protractor, autoflow, autovitals, carfax,
      enterprise_id, is_active, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      ${data.name},
      ${data.slug || null},
      ${data.ownerId || null},
      ${shopIdStr},
      ${data.settings ? JSON.stringify(data.settings) : null}::jsonb,
      ${data.branding ? JSON.stringify(data.branding) : null}::jsonb,
      ${data.billing ? JSON.stringify(data.billing) : null}::jsonb,
      ${data.tekmetric ? JSON.stringify(data.tekmetric) : null}::jsonb,
      ${data.protractor ? JSON.stringify(data.protractor) : null}::jsonb,
      ${data.autoflow ? JSON.stringify(data.autoflow) : null}::jsonb,
      ${data.autovitals ? JSON.stringify(data.autovitals) : null}::jsonb,
      ${data.carfax ? JSON.stringify(data.carfax) : null}::jsonb,
      ${data.enterpriseId || null},
      ${data.isActive !== false},
      ${now},
      ${now}
    )
    ON CONFLICT (shop_id) WHERE shop_id IS NOT NULL
    DO UPDATE SET
      name = COALESCE(EXCLUDED.name, shops.name),
      slug = COALESCE(EXCLUDED.slug, shops.slug),
      owner_id = COALESCE(EXCLUDED.owner_id, shops.owner_id),
      settings = COALESCE(EXCLUDED.settings, shops.settings),
      branding = COALESCE(EXCLUDED.branding, shops.branding),
      billing = COALESCE(EXCLUDED.billing, shops.billing),
      tekmetric = COALESCE(EXCLUDED.tekmetric, shops.tekmetric),
      protractor = COALESCE(EXCLUDED.protractor, shops.protractor),
      autoflow = COALESCE(EXCLUDED.autoflow, shops.autoflow),
      autovitals = COALESCE(EXCLUDED.autovitals, shops.autovitals),
      carfax = COALESCE(EXCLUDED.carfax, shops.carfax),
      enterprise_id = COALESCE(EXCLUDED.enterprise_id, shops.enterprise_id),
      updated_at = ${now}
    RETURNING *
  `;
  
  return shops[0];
}

export async function getShopUUIDByIntegerId(shopIntId: number | string): Promise<string | null> {
  const shop = await getShopByShopId(shopIntId);
  return shop?.id || null;
}

export async function getShopIntegerIdByUUID(shopUUID: string): Promise<number | null> {
  const shop = await getShopById(shopUUID);
  return shop?.shop_id ? Number(shop.shop_id) : null;
}
