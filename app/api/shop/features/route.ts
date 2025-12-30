// app/api/shop/features/route.ts
// Get enabled features for the current shop

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getEnabledFeatures, FEATURES, FeatureId } from "@/lib/features";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const enabledFeatureIds = await getEnabledFeatures(shopId);
  
  const enabledFeatures = FEATURES.filter(f => 
    enabledFeatureIds.includes(f.id as FeatureId)
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
