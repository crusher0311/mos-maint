import { getDb } from '@/lib/mongo';

export type ShopLookupResult = {
  mosShopId: number;
  shopDoc: any;
  provider: 'tekmetric' | 'protractor' | 'shopware' | 'autoflow' | 'shopmonkey';
} | null;

/**
 * Test seam: tests can override `__deps.getDb` to swap in a fake DB and
 * `__deps.discoverShopmonkeyIds` to stub the Shopmonkey `/location` call.
 * Production callers go through the real getDb()/discoverIdsFromKey() unchanged.
 */
export const __deps: {
  getDb: typeof getDb;
  discoverShopmonkeyIds: (
    apiKey: string,
  ) => Promise<{ companyId: string | null; locationId: string | null }>;
} = {
  getDb,
  discoverShopmonkeyIds: async (apiKey: string) => {
    const { discoverIdsFromKey } = await import(
      "@/lib/integrations/shopmonkey/auth"
    );
    return discoverIdsFromKey(apiKey);
  },
};

export async function findShopBySmsId(
  smsShopId: string,
  options: {
    userShopIds?: number[];
    isPlatformAdmin?: boolean;
    providerHint?: string;
  } = {}
): Promise<ShopLookupResult> {
  const db = await __deps.getDb();
  const { userShopIds = [], isPlatformAdmin = false, providerHint } = options;
  
  const tekShopIdNum = parseInt(smsShopId);
  const tekShopIdStr = String(smsShopId);

  // AutoFlow identifiers (a v3 subdomain or a v4 shop NUMBER) must only ever
  // match AutoFlow fields. A v4 slug is frequently numeric, so matching it
  // against the generic `shopId` / `tekmetric.shopId` clauses below could
  // resolve it to a completely unrelated shop (wrong-shop context/data). When
  // the caller tells us this is an AutoFlow page, restrict the query to
  // AutoFlow fields only.
  const autoflowOr = [
    { "autoflow.shopId": smsShopId },
    { "autoflow.shopNumbers": smsShopId },
    { "autoflow.domain": smsShopId },
    { "autoflow.domain": `${smsShopId}.autotext.me` },
    { "autoflow.subdomain": smsShopId },
    { autoflowDomain: smsShopId },
    { autoflowDomain: `${smsShopId}.autotext.me` },
  ];

  const shopQuery: any = {
    $or: providerHint === 'autoflow' ? autoflowOr : [
      ...(isNaN(tekShopIdNum) ? [] : [{ shopId: tekShopIdNum }]),
      { "tekmetric.shopId": tekShopIdNum },
      { "tekmetric.shopId": tekShopIdStr },
      { tekmetricShopId: tekShopIdNum },
      { tekmetricShopId: tekShopIdStr },
      { "protractor.connectionId": smsShopId },
      { protractorConnectionId: smsShopId },
      ...autoflowOr,
      { "shopware.tenantSubdomain": smsShopId },
      { "shopware.tenantId": smsShopId },
      { "shopmonkey.locationId": smsShopId },
      { "shopmonkey.companyId": smsShopId },
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

  // AutoFlow auto-learn (v3 -> v4 migration). AutoFlow is mid framework upgrade
  // and most shops are reachable via BOTH a v3 per-shop subdomain
  // (harrells-nc87.autotext.me) AND a v4 shared host with the shop NUMBER in the
  // path (app.autoflow.com/shop/<number>). That v4 number is a different
  // identifier and often isn't stored, so the lookup above misses on v4 URLs.
  // When we can confidently pin the single AutoFlow shop this user is working
  // in, learn the identifier so every future lookup (this and other routes)
  // resolves instantly. Mirrors the Shop-Ware fallback: only auto-associate on
  // a SINGLE candidate so we never link the wrong shop. Non-admins are scoped
  // to their own shops; platform admins (unscoped) won't auto-learn when many
  // AutoFlow shops exist, which is the safe outcome.
  const looksLikeAutoflowId =
    typeof smsShopId === 'string' &&
    smsShopId.trim().length > 0 &&
    smsShopId.trim().length <= 64 &&
    !/\s/.test(smsShopId);
  if (!shopDoc && providerHint === 'autoflow' && looksLikeAutoflowId) {
    const afFallbackQuery: any = {
      $or: [
        { "autoflow.domain": { $exists: true } },
        { "autoflow.subdomain": { $exists: true } },
        { "autoflow.shopId": { $exists: true } },
        { "autoflow.configured": true },
        { autoflowDomain: { $exists: true } },
      ],
    };
    if (!isPlatformAdmin && userShopIds.length > 0) {
      const shopIdVariants = userShopIds.flatMap(id => [id, String(id)]);
      afFallbackQuery.shopId = { $in: shopIdVariants };
    }
    const candidates = await db.collection("shops").find(afFallbackQuery).toArray();

    if (candidates.length === 1) {
      shopDoc = candidates[0];
      console.log(`[Shop Lookup] AutoFlow fallback: single shop ${shopDoc.shopId} for AutoFlow id "${smsShopId}" — learning it for future lookups`);
      await db.collection("shops").updateOne(
        { _id: shopDoc._id },
        { $addToSet: { "autoflow.shopNumbers": smsShopId } }
      );
    } else if (candidates.length > 1) {
      console.warn(`[Shop Lookup] AutoFlow fallback: ${candidates.length} candidate shops for AutoFlow id "${smsShopId}" — cannot auto-associate. Shops: ${candidates.map(s => s.shopId).join(', ')}`);
    }
  }

  // Shopmonkey self-onboard (key present, ids missing). Shopmonkey is a
  // single-host SPA, so the content script reads the shop's company/location id
  // off the page (a 24-hex ObjectId). Shops connected with only an API key have
  // `shopmonkey.companyId`/`locationId` set to null, so the primary $or above
  // misses and we (correctly) fail closed. Here we derive each candidate key's
  // own ids from Shopmonkey `GET /location` (every key reports ONLY its own
  // location), persist them, and match against the on-page id. This is bounded
  // and self-terminating: we only touch shops that are keyed-but-unidded, and
  // once their ids are stored the primary $or resolves them directly. The
  // per-key id check disambiguates a user with several Shopmonkey shops (each
  // key returns a different id), and a genuine no-match still returns null.
  const looksLikeShopmonkeyId =
    typeof smsShopId === 'string' && /^[a-f0-9]{24}$/i.test(smsShopId.trim());
  const shopmonkeyContext =
    providerHint === 'shopmonkey' || (!providerHint && looksLikeShopmonkeyId);
  if (!shopDoc && shopmonkeyContext) {
    const smFallbackQuery: any = {
      'shopmonkey.apiKey': { $exists: true, $ne: null },
      $or: [
        { 'shopmonkey.companyId': { $in: [null, undefined] } },
        { 'shopmonkey.locationId': { $in: [null, undefined] } },
      ],
    };
    if (!isPlatformAdmin && userShopIds.length > 0) {
      const shopIdVariants = userShopIds.flatMap(id => [id, String(id)]);
      smFallbackQuery.shopId = { $in: shopIdVariants };
    }
    const candidates = await db.collection("shops").find(smFallbackQuery).toArray();

    for (const cand of candidates) {
      const apiKey = cand?.shopmonkey?.apiKey;
      if (!apiKey) continue;

      const { companyId, locationId } = await __deps.discoverShopmonkeyIds(apiKey);
      if (!companyId && !locationId) continue;

      // Persist only the ids we learned that aren't already stored, so future
      // lookups resolve through the primary $or instead of re-discovering.
      const set: Record<string, string> = {};
      if (companyId && !cand.shopmonkey?.companyId) set["shopmonkey.companyId"] = companyId;
      if (locationId && !cand.shopmonkey?.locationId) set["shopmonkey.locationId"] = locationId;
      if (Object.keys(set).length > 0) {
        await db.collection("shops").updateOne({ _id: cand._id }, { $set: set });
        cand.shopmonkey = {
          ...cand.shopmonkey,
          ...(companyId ? { companyId } : {}),
          ...(locationId ? { locationId } : {}),
        };
      }

      if (smsShopId === companyId || smsShopId === locationId) {
        shopDoc = cand;
        console.log(`[Shop Lookup] Shopmonkey self-heal: shop ${cand.shopId} matched on-page id "${smsShopId}" after discovering ids from its key`);
        break;
      }
    }
  }

  if (!shopDoc) {
    return null;
  }
  
  const provider = shopDoc.integrationProvider 
    || (shopDoc.tekmetric?.shopId ? 'tekmetric' 
      : shopDoc.protractor?.connectionId ? 'protractor' 
      : shopDoc.shopware?.tenantId ? 'shopware'
      : shopDoc.shopmonkey?.apiKey ? 'shopmonkey'
      : shopDoc.autoflow?.domain ? 'autoflow' 
      : 'tekmetric') as 'tekmetric' | 'protractor' | 'shopware' | 'autoflow' | 'shopmonkey';
  
  return {
    mosShopId: Number(shopDoc.shopId),
    shopDoc,
    provider
  };
}
