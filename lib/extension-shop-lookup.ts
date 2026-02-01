import sql from "@/lib/db/postgres";

export type ShopLookupResult = {
  mosShopId: number;
  shopDoc: Record<string, unknown>;
  provider: 'tekmetric' | 'protractor' | 'autoflow';
} | null;

export async function findShopBySmsId(
  smsShopId: string,
  options: {
    userShopIds?: number[];
    isPlatformAdmin?: boolean;
  } = {}
): Promise<ShopLookupResult> {
  const { userShopIds = [], isPlatformAdmin = false } = options;
  
  const tekShopIdNum = parseInt(smsShopId);
  const tekShopIdStr = String(smsShopId);
  
  let rows;
  
  if (!isPlatformAdmin && userShopIds.length > 0) {
    const shopIdStrs = userShopIds.map(id => String(id));
    rows = await sql`
      SELECT id, shop_id, name, integration_provider, tekmetric_shop_id, protractor_connection_id, settings
      FROM shops
      WHERE shop_id = ANY(${shopIdStrs})
        AND (
          tekmetric_shop_id = ${tekShopIdNum}
          OR tekmetric_shop_id = ${tekShopIdStr}::int
          OR protractor_connection_id = ${smsShopId}
          OR settings->'autoflow'->>'shopId' = ${smsShopId}
          OR settings->'autoflow'->>'domain' = ${smsShopId}
        )
      LIMIT 1
    `;
  } else {
    rows = await sql`
      SELECT id, shop_id, name, integration_provider, tekmetric_shop_id, protractor_connection_id, settings
      FROM shops
      WHERE (
        tekmetric_shop_id = ${tekShopIdNum}
        OR protractor_connection_id = ${smsShopId}
        OR settings->'autoflow'->>'shopId' = ${smsShopId}
        OR settings->'autoflow'->>'domain' = ${smsShopId}
      )
      LIMIT 1
    `;
  }
  
  const shopDoc = rows[0];
  if (!shopDoc) {
    return null;
  }
  
  const settings = shopDoc.settings as Record<string, unknown> | null;
  const hasAutoflow = settings?.autoflow ? true : false;
  
  let provider: 'tekmetric' | 'protractor' | 'autoflow' = 'tekmetric';
  const storedProvider = shopDoc.integration_provider as string | null;
  
  if (storedProvider === 'tekmetric' || storedProvider === 'protractor' || storedProvider === 'autoflow') {
    provider = storedProvider;
  } else if (shopDoc.tekmetric_shop_id) {
    provider = 'tekmetric';
  } else if (shopDoc.protractor_connection_id) {
    provider = 'protractor';
  } else if (hasAutoflow) {
    provider = 'autoflow';
  }
  
  return {
    mosShopId: parseInt(shopDoc.shop_id as string),
    shopDoc: {
      id: shopDoc.id,
      shopId: parseInt(shopDoc.shop_id as string),
      name: shopDoc.name,
      integrationProvider: shopDoc.integration_provider,
      tekmetricShopId: shopDoc.tekmetric_shop_id,
      protractorConnectionId: shopDoc.protractor_connection_id,
      settings: settings,
    },
    provider
  };
}
