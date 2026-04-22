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
    providerHint?: string;
  } = {}
): Promise<ShopLookupResult> {
  const db = await getDb();
  const { userShopIds = [], isPlatformAdmin = false, providerHint } = options;
  
  const tekShopIdNum = parseInt(smsShopId);
  const tekShopIdStr = String(smsShopId);
  
  const shopQuery: any = {
    $or: [
      ...(isNaN(tekShopIdNum) ? [] : [{ shopId: tekShopIdNum }]),
      { "tekmetric.shopId": tekShopIdNum },
      { "tekmetric.shopId": tekShopIdStr },
      { tekmetricShopId: tekShopIdNum },
      { tekmetricShopId: tekShopIdStr },
      { "protractor.connectionId": smsShopId },
      { protractorConnectionId: smsShopId },
      { "autoflow.shopId": smsShopId },
      { "autoflow.domain": smsShopId },
      { "autoflow.domain": `${smsShopId}.autotext.me` },
      { "autoflow.subdomain": smsShopId },
      { autoflowDomain: smsShopId },
      { autoflowDomain: `${smsShopId}.autotext.me` },
      { "shopware.tenantSubdomain": smsShopId },
      { "shopware.tenantId": smsShopId },
    ]
  };
  
  if (!isPlatformAdmin && userShopIds.length > 0) {
    const shopIdVariants: (string | number)[] = [];
    for (const id of userShopIds) {
      const str = String(id);
      const num = Number(id);
      if (!shopIdVariants.includes(str)) shopIdVariants.push(str);
      if (Number.isFinite(num) && !shopIdVariants.includes(num)) shopIdVariants.push(num);
    }
    shopQuery.shopId = { $in: shopIdVariants };
  }
  
  let shopDoc = await db.collection("shops").findOne(shopQuery);
  
  if (!shopDoc) {
    console.log(`[Shop Lookup] No match for smsShopId=${smsShopId}, userShopIds=${JSON.stringify(userShopIds)}, isPlatformAdmin=${isPlatformAdmin}, providerHint=${providerHint || 'none'}`);
    const anyShop = await db.collection("shops").findOne({
      $or: [
        { "tekmetric.shopId": tekShopIdNum },
        { "tekmetric.shopId": tekShopIdStr },
        { tekmetricShopId: tekShopIdNum },
        { tekmetricShopId: tekShopIdStr },
        { "protractor.connectionId": smsShopId },
        { protractorConnectionId: smsShopId },
        { "shopware.tenantSubdomain": smsShopId },
        { "shopware.tenantId": smsShopId },
      ]
    }, { projection: { shopId: 1, name: 1, integrationProvider: 1 } });
    if (anyShop) {
      console.log(`[Shop Lookup] Shop exists (shopId=${anyShop.shopId}, name=${anyShop.name}) but user lacks access. shopId type=${typeof anyShop.shopId}`);
    } else {
      console.log(`[Shop Lookup] No shop configured with SMS ID ${smsShopId} in any provider field`);
    }
  }
  
  if (!shopDoc && providerHint === 'shopware') {
    const swFallbackQuery: any = {
      "shopware.tenantId": { $exists: true },
    };
    if (!isPlatformAdmin && userShopIds.length > 0) {
      const shopIdVariants = userShopIds.flatMap(id => [id, String(id)]);
      swFallbackQuery.shopId = { $in: shopIdVariants };
    }
    const candidates = await db.collection("shops").find(swFallbackQuery).toArray();
    
    if (candidates.length === 1) {
      shopDoc = candidates[0];
      console.log(`[Shop Lookup] Shop-Ware fallback: single match shop ${shopDoc.shopId} for subdomain "${smsShopId}" — saving for future lookups`);
      await db.collection("shops").updateOne(
        { _id: shopDoc._id },
        { $set: { "shopware.tenantSubdomain": smsShopId } }
      );
    } else if (candidates.length > 1) {
      console.warn(`[Shop Lookup] Shop-Ware fallback: ${candidates.length} candidate shops for subdomain "${smsShopId}" — cannot auto-associate. Shops: ${candidates.map(s => s.shopId).join(', ')}`);
    }
  }
  
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
    mosShopId: Number(shopDoc.shopId),
    shopDoc,
    provider
  };
}
