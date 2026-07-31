// app/api/admin/features/route.ts
// Platform admin - Get all features and per-shop effective feature state.
//
// Task #975: this used to list the standalone `shop_features` collection,
// which the entitlement resolver never reads — so the page showed (and its
// toggles wrote) state that had no effect. It now reports the same
// resolver-backed state the rest of the app uses: per-shop overrides in
// `shops.enabledFeatures`, merged over enterprise settings and plan
// defaults (shop override ?? enterprise ?? plan ?? false; founder = all).

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { FEATURES } from "@/lib/features";
import {
  getPlanFeaturesFromDatabase,
  normalizeShopFeatureOverrides,
  isFounderPlan,
  type BillingPlan,
  type FeatureKey,
  type FeatureSettings,
} from "@/lib/featureResolver";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session || (session.role !== "platform_admin" && session.role !== "admin")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();

  const shops = await db.collection("shops")
    .find({})
    .project({
      _id: 0,
      shopId: 1,
      name: 1,
      enabledFeatures: 1,
      "billing.plan": 1,
      enterpriseId: 1,
    })
    .toArray();

  // Resolve plan defaults once per distinct plan (not per shop).
  const planCache = new Map<string, FeatureSettings>();
  const planFeaturesFor = async (plan: BillingPlan): Promise<FeatureSettings> => {
    const cached = planCache.get(plan);
    if (cached) return cached;
    const features = await getPlanFeaturesFromDatabase(plan);
    planCache.set(plan, features);
    return features;
  };

  // Enterprise feature settings, fetched once per distinct enterprise.
  const enterpriseIds = Array.from(
    new Set(shops.filter(s => s.enterpriseId).map(s => String(s.enterpriseId))),
  );
  const enterpriseFeatureMap = new Map<string, Partial<FeatureSettings>>();
  if (enterpriseIds.length > 0) {
    const { ObjectId } = await import("mongodb");
    const objectIds = enterpriseIds
      .filter(id => ObjectId.isValid(id))
      .map(id => new ObjectId(id));
    if (objectIds.length > 0) {
      const enterprises = await db.collection("enterprise_accounts")
        .find({ _id: { $in: objectIds } })
        .project({ featureSettings: 1 })
        .toArray();
      for (const ent of enterprises) {
        enterpriseFeatureMap.set(
          String(ent._id),
          (ent.featureSettings as Partial<FeatureSettings>) || {},
        );
      }
    }
  }

  const legacyIds = FEATURES.map(f => f.id);

  const shopFeatures = await Promise.all(shops.map(async shop => {
    const plan: BillingPlan = shop.billing?.plan || "trial";
    let enabledFeatures: string[];
    if (isFounderPlan(plan)) {
      enabledFeatures = [...legacyIds];
    } else {
      const overrides = normalizeShopFeatureOverrides(shop.enabledFeatures);
      const enterpriseFeatures = shop.enterpriseId
        ? enterpriseFeatureMap.get(String(shop.enterpriseId)) || {}
        : {};
      const planFeatures = await planFeaturesFor(plan);
      enabledFeatures = legacyIds.filter(id => {
        const key = id as FeatureKey;
        return (
          overrides[key] ?? enterpriseFeatures[key] ?? planFeatures[key] ?? false
        ) === true;
      });
    }
    return {
      shopId: shop.shopId,
      shopName: shop.name || `Shop ${shop.shopId}`,
      planLocked: isFounderPlan(plan),
      enabledFeatures,
      featureSettings: {},
      subscriptions: [],
    };
  }));

  return NextResponse.json({
    ok: true,
    features: FEATURES,
    shopFeatures,
  });
}
