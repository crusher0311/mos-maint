// app/api/admin/features/route.ts
// Platform admin - Get all features and shop feature configurations

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { FEATURES, ShopFeatures } from "@/lib/features";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session || (session.role !== "platform_admin" && session.role !== "admin")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  
  const shopFeatures = await db.collection<ShopFeatures>("shop_features")
    .find({})
    .toArray();

  const shops = await db.collection("shops")
    .find({})
    .project({ _id: 0, shopId: 1, name: 1 })
    .toArray();

  const shopMap = new Map(shops.map(s => [s.shopId, s.name]));

  const shopFeaturesWithNames = shopFeatures.map(sf => ({
    ...sf,
    shopName: shopMap.get(sf.shopId) || `Shop ${sf.shopId}`,
  }));

  return NextResponse.json({
    ok: true,
    features: FEATURES,
    shopFeatures: shopFeaturesWithNames,
  });
}
