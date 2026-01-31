// lib/shops.ts
import sql from "@/lib/db/postgres";

export interface Shop {
  id: string;
  shop_id: string;
  name: string;
  slug: string;
  owner_id: string;
  settings: Record<string, unknown>;
  is_active: boolean;
  enterprise_id: string | null;
  billing: Record<string, unknown> | null;
  tekmetric: Record<string, unknown> | null;
  protractor: Record<string, unknown> | null;
  autoflow: Record<string, unknown> | null;
  carfax: Record<string, unknown> | null;
  autovitals: Record<string, unknown> | null;
  sticker_config: Record<string, unknown> | null;
  branding: Record<string, unknown> | null;
  location_identifier: string | null;
  webhook_token: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function getShopById(shopId: number): Promise<Shop | null> {
  const shops = await sql<Shop[]>`
    SELECT * FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
  `;
  return shops[0] || null;
}

export async function getShopBySlug(slug: string): Promise<Shop | null> {
  const shops = await sql<Shop[]>`
    SELECT * FROM shops WHERE slug = ${slug} LIMIT 1
  `;
  return shops[0] || null;
}

export async function updateShop(shopId: number, updates: Partial<Shop>): Promise<Shop | null> {
  const allowedFields = ['name', 'settings', 'billing', 'sticker_config', 'branding', 'location_identifier'];
  const updateEntries = Object.entries(updates).filter(([key]) => allowedFields.includes(key));
  
  if (updateEntries.length === 0) return getShopById(shopId);
  
  const shops = await sql<Shop[]>`
    UPDATE shops 
    SET ${sql(Object.fromEntries(updateEntries))}, updated_at = NOW()
    WHERE shop_id = ${String(shopId)}
    RETURNING *
  `;
  return shops[0] || null;
}
