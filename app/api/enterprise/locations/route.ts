import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getEnterpriseForShop } from "@/lib/enterprise";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const currentShopId = Number(session.shopId);
  const enterprise = await getEnterpriseForShop(currentShopId);

  if (!enterprise) {
    return NextResponse.json({ locations: [] });
  }

  const db = await getDb();
  const otherShopIds = enterprise.shopIds.filter((id: number) => id !== currentShopId);

  if (otherShopIds.length === 0) {
    return NextResponse.json({ locations: [] });
  }

  const shops = await db.collection("shops").find(
    { shopId: { $in: otherShopIds } },
    { projection: { shopId: 1, name: 1, locationIdentifier: 1 } }
  ).toArray();

  const locations = shops.map((shop) => ({
    shopId: shop.shopId,
    name: shop.locationIdentifier 
      ? `${shop.name || `Shop ${shop.shopId}`} (${shop.locationIdentifier})`
      : shop.name || `Shop ${shop.shopId}`,
  }));

  return NextResponse.json({
    ok: true,
    enterpriseId: enterprise._id,
    enterpriseName: enterprise.name,
    locations,
  });
}
