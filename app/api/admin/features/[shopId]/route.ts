// app/api/admin/features/[shopId]/route.ts
// Platform admin - Manage features for a specific shop

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { 
  getShopFeatures, 
  setShopFeatures, 
  enableFeature, 
  disableFeature,
  FeatureId,
  FEATURES,
} from "@/lib/features";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  const session = await getSession();
  if (!session || (session.role !== "platform_admin" && session.role !== "admin")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(params.shopId);
  if (isNaN(shopId)) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  const features = await getShopFeatures(shopId);

  return NextResponse.json({
    ok: true,
    shopId,
    features: features || {
      shopId,
      enabledFeatures: ["maintenance"],
      featureSettings: {},
      subscriptions: [],
    },
    availableFeatures: FEATURES,
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  const session = await getSession();
  if (!session || (session.role !== "platform_admin" && session.role !== "admin")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(params.shopId);
  if (isNaN(shopId)) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  const body = await req.json();
  const { enabledFeatures } = body as { enabledFeatures: FeatureId[] };

  if (!Array.isArray(enabledFeatures)) {
    return NextResponse.json({ error: "enabledFeatures must be an array" }, { status: 400 });
  }

  const validFeatureIds = new Set(FEATURES.map(f => f.id));
  const validatedFeatures = enabledFeatures.filter(f => validFeatureIds.has(f));

  await setShopFeatures(shopId, validatedFeatures);

  return NextResponse.json({
    ok: true,
    shopId,
    enabledFeatures: validatedFeatures,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  const session = await getSession();
  if (!session || (session.role !== "platform_admin" && session.role !== "admin")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(params.shopId);
  if (isNaN(shopId)) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  const body = await req.json();
  const { action, featureId } = body as { action: "enable" | "disable"; featureId: FeatureId };

  if (!action || !featureId) {
    return NextResponse.json({ error: "action and featureId are required" }, { status: 400 });
  }

  const validFeatureIds = new Set(FEATURES.map(f => f.id));
  if (!validFeatureIds.has(featureId)) {
    return NextResponse.json({ error: "Invalid feature ID" }, { status: 400 });
  }

  if (action === "enable") {
    await enableFeature(shopId, featureId);
  } else if (action === "disable") {
    await disableFeature(shopId, featureId);
  } else {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const features = await getShopFeatures(shopId);

  return NextResponse.json({
    ok: true,
    shopId,
    enabledFeatures: features?.enabledFeatures || [],
  });
}
