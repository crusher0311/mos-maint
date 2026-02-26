import { getDb } from '@/lib/mongo';

export type ShopLookupResult = {
  mosShopId: number;
  shopDoc: any;
  provider: 'tekmetric' | 'protractor' | 'shopware' | 'autoflow';
} | null;

export async function findShopBySmsId(
  smsShopId: string,
  options: {
    userShopIds?: number[];
    isPlatformAdmin?: boolean;
  } = {}
): Promise<ShopLookupResult> {
  const db = await getDb();
  const { userShopIds = [], isPlatformAdmin = false } = options;
  
  const tekShopIdNum = parseInt(smsShopId);
  const tekShopIdStr = String(smsShopId);
  
  const shopQuery: any = {
    $or: [
      { "tekmetric.shopId": tekShopIdNum },
      { "tekmetric.shopId": tekShopIdStr },
      { tekmetricShopId: tekShopIdNum },
      { tekmetricShopId: tekShopIdStr },
      { "protractor.connectionId": smsShopId },
      { protractorConnectionId: smsShopId },
      { "autoflow.shopId": smsShopId },
      { "autoflow.domain": smsShopId },
      { "shopware.tenantSubdomain": smsShopId },
    ]
  };
  
  if (!isPlatformAdmin && userShopIds.length > 0) {
    shopQuery.shopId = { $in: userShopIds };
  }
  
  const shopDoc = await db.collection("shops").findOne(shopQuery);
  
  if (!shopDoc) {
    return null;
  }
  
  const provider = shopDoc.integrationProvider 
    || (shopDoc.tekmetric?.shopId ? 'tekmetric' 
      : shopDoc.protractor?.connectionId ? 'protractor' 
      : shopDoc.shopware?.tenantId ? 'shopware'
      : shopDoc.autoflow?.domain ? 'autoflow' 
      : 'tekmetric') as 'tekmetric' | 'protractor' | 'shopware' | 'autoflow';
  
  return {
    mosShopId: shopDoc.shopId,
    shopDoc,
    provider
  };
}
