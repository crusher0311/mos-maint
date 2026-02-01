import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { FEATURES } from "@/lib/features";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session || (session.role !== "platform_admin" && session.role !== "admin")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopFeatures = await sql`
    SELECT * FROM shop_features
  `;

  const shops = await sql`
    SELECT shop_id, name FROM shops
  `;

  const shopMap = new Map(shops.map(s => [s.shop_id, s.name]));

  const shopFeaturesWithNames = shopFeatures.map(sf => ({
    ...sf,
    shopId: sf.shop_id,
    shopName: shopMap.get(sf.shop_id) || `Shop ${sf.shop_id}`,
  }));

  return NextResponse.json({
    ok: true,
    features: FEATURES,
    shopFeatures: shopFeaturesWithNames,
  });
}
