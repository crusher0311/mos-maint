import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import { canManageEnterpriseLaborRates } from "@/lib/labor-rate-rules";
import { listShopsByShopIds } from "@/lib/data/repositories/shops";
import { canManageEnterpriseSettings } from "@/lib/enterprise-settings-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageEnterpriseSettings(session)) {
    return NextResponse.json({ error: "Permission denied" }, { status: 403 });
  }

  const currentShopId = Number(session.shopId);
  const enterprise = await getEnterpriseByShopId(currentShopId);

  if (!enterprise) {
    return NextResponse.json({ locations: [] });
  }

  const otherShopIds = enterprise.shopIds
    .map(Number)
    .filter((id: number) => Number.isFinite(id) && id !== currentShopId);

  if (otherShopIds.length === 0) {
    return NextResponse.json({ locations: [] });
  }

  const shops = await listShopsByShopIds(
    otherShopIds,
    { shopId: 1, name: 1, locationIdentifier: 1 },
  );

  const locations = shops.map((shop) => ({
    shopId: Number(shop.shopId),
    name: shop.locationIdentifier 
      ? `${shop.name || `Shop ${shop.shopId}`} (${shop.locationIdentifier})`
      : shop.name || `Shop ${shop.shopId}`,
  }));

  return NextResponse.json({
    ok: true,
    enterpriseId: enterprise._id,
    enterpriseName: enterprise.name,
    canManageLaborRates: canManageEnterpriseLaborRates(session),
    canManageSettings: true,
    locations,
  });
}
