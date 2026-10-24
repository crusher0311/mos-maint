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
import { FEATURES } from "@/lib/features";
import { listAllShops } from "@/lib/data/repositories/shops";
import {
  getFeatureEntitlements,
  isFounderPlan,
  type BillingPlan,
  type FeatureKey,
} from "@/lib/featureResolver";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session || (session.role !== "platform_admin" && session.role !== "admin")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shops: any[] = await listAllShops();

  const legacyIds = FEATURES.map(f => f.id);

  const shopFeatures = await Promise.all(shops.map(async shop => {
    const plan: BillingPlan = shop.billing?.plan || "trial";
    const entitlement = await getFeatureEntitlements(Number(shop.shopId), { throwIfMissing: true });
    return {
      shopId: shop.shopId,
      shopName: shop.name || `Shop ${shop.shopId}`,
      planLocked: isFounderPlan(plan),
      enabledFeatures: legacyIds.filter(id => entitlement.configuredFeatures?.[id as FeatureKey]),
      usableFeatures: legacyIds.filter(id => entitlement.canUseFeature(id as FeatureKey)),
      eligibility: entitlement.eligibility,
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
