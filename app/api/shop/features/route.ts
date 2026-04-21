// app/api/shop/features/route.ts
// Get enabled features for the current shop

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getFeatureEntitlements, FEATURE_KEYS, FEATURE_METADATA } from "@/lib/featureResolver";
import { FEATURES } from "@/lib/features";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const entitlements = await getFeatureEntitlements(shopId);

  const enabledFeatureIds: string[] = [];
  for (const key of FEATURE_KEYS) {
    if (entitlements.effectiveFeatures[key]) {
      enabledFeatureIds.push(key);
    }
  }

  const featuresById = new Map(FEATURES.map(f => [f.id as string, f]));
  const enabledFeatures = enabledFeatureIds.map(id => {
    const f = featuresById.get(id);
    if (f) {
      return { id: f.id, name: f.name, description: f.description, icon: f.icon };
    }
    const meta = FEATURE_METADATA[id as keyof typeof FEATURE_METADATA];
    return { id, name: meta.name, description: meta.description, icon: "Sparkles" };
  });

  return NextResponse.json({
    ok: true,
    enabledFeatures,
    enabledFeatureIds,
    billing: {
      status: entitlements.billing.status,
      plan: entitlements.billing.plan,
      gracePeriodEndsAt: entitlements.billing.gracePeriodEndsAt || null,
    },
  });
}
