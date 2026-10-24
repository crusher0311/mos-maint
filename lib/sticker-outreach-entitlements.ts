import type { Db } from "mongodb";
import { inArray } from "drizzle-orm";
import { getDb as getPgDb } from "./db/drizzle";
import { shopFeatures, enterpriseAccounts } from "./db/schema/wave4";
import { isIdentityPgCanonical } from "./db/wave4-write-mode";
import { getPlanFeaturesFromDatabase, resolveFeatureEntitlementsSnapshot, type BillingPlan } from "./featureResolver";

/** One metadata read and one enterprise read; plan reads are per distinct tier. */
export async function stickerOutreachEntitlements(db: Db, shops: any[], enterprises: any[]) {
  const ids = [...new Set(shops.map(s => Number(s.shopId)).filter(Number.isFinite))];
  const subscriptions = new Map<string, any[]>();
  let enterpriseRows = enterprises;
  if (isIdentityPgCanonical()) {
    const pg = getPgDb();
    const enterpriseIds = [...new Set(shops.map(s => String(s.enterpriseId || "")).filter(Boolean))];
    const [rows, accounts] = await Promise.all([
      ids.length ? pg.select().from(shopFeatures).where(inArray(shopFeatures.shopId, ids)) : [],
      enterpriseIds.length ? pg.select().from(enterpriseAccounts).where(inArray(enterpriseAccounts.id, enterpriseIds)) : [],
    ]);
    enterpriseRows = accounts.map(row => ({ ...row, _id: row.id }));
    for (const row of rows) {
      const key = String(row.shopId);
      if (row.subscription) subscriptions.set(key, [...(subscriptions.get(key) || []), row.subscription]);
    }
  } else {
    const rows = await db.collection("shop_features").find(
      { shopId: { $in: ids.flatMap(id => [id, String(id)]) } },
      { projection: { shopId: 1, subscriptions: 1 }, maxTimeMS: 3000 },
    ).toArray();
    for (const row of rows) {
      const key = String(row.shopId);
      subscriptions.set(key, [...(subscriptions.get(key) || []), ...(Array.isArray(row.subscriptions) ? row.subscriptions : [])]);
    }
  }
  const plans = [...new Set(shops.map(s => (s.billing?.plan || "trial") as BillingPlan))];
  const planFeatures = new Map(await Promise.all(plans.map(async plan => [plan, await getPlanFeaturesFromDatabase(plan)] as const)));
  const enterpriseMap = new Map(enterpriseRows.map(row => [String(row._id), row.featureSettings || {}]));
  return new Map(shops.map(shop => [String(shop.shopId),
    resolveFeatureEntitlementsSnapshot(shop, enterpriseMap.get(String(shop.enterpriseId)) || {},
      planFeatures.get(shop.billing?.plan || "trial")!,
      { subscriptions: subscriptions.get(String(shop.shopId)) || [] }).canUseFeature("oil_sticker"),
  ]));
}
