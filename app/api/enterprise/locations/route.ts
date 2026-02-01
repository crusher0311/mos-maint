import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { getEnterpriseByShopId } from "@/lib/enterprise";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const currentShopId = Number(session.shopId);
  const enterprise = await getEnterpriseByShopId(currentShopId);

  if (!enterprise) {
    return NextResponse.json({ locations: [] });
  }

  const otherShopIds = enterprise.shopIds.filter((id: number) => id !== currentShopId).map(String);

  if (otherShopIds.length === 0) {
    return NextResponse.json({ locations: [] });
  }

  const shops = await sql`
    SELECT shop_id, name, settings->>'locationIdentifier' as location_identifier 
    FROM shops 
    WHERE shop_id = ANY(${otherShopIds})
  `;

  const locations = shops.map((shop: any) => ({
    shopId: shop.shop_id,
    name: shop.location_identifier 
      ? `${shop.name || `Shop ${shop.shop_id}`} (${shop.location_identifier})`
      : shop.name || `Shop ${shop.shop_id}`,
  }));

  return NextResponse.json({
    ok: true,
    enterpriseId: enterprise.id,
    enterpriseName: enterprise.name,
    locations,
  });
}
