// app/api/shop/features/route.ts
// Get enabled features for the current shop

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getFeatureEntitlements, FeatureKey } from "@/lib/featureResolver";
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
  const featureKeys: FeatureKey[] = ["maintenance", "job_lookup", "common_failures", "oil_sticker", "keytags", "auto_booking", "part_xref"];
  
  for (const key of featureKeys) {
    if (entitlements.effectiveFeatures[key]) {
      enabledFeatureIds.push(key);
    }
  }
  
  const enabledFeatures = FEATURES.filter(f => 
    enabledFeatureIds.includes(f.id)
  ).map(f => ({
    id: f.id,
    name: f.name,
    description: f.description,
    icon: f.icon,
  }));

  return NextResponse.json({
    ok: true,
    enabledFeatures,
    enabledFeatureIds,
  });
}
