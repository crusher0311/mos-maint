import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import { listShopsByShopIds } from "@/lib/data/repositories/shops";
import { canManageEnterpriseSettings } from "@/lib/enterprise-settings-catalog";
import { copySettingsPost } from "@/app/api/enterprise/copy-settings/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Compatibility endpoint for existing oil-sticker clients. Authorization,
 * enterprise scoping, snapshots, protected fields, and result reporting all
 * come from the shared settings contract.
 */
export async function POST(req: NextRequest) {
  return copySettingsPost(req, {
    forceCategory: "stickers",
    legacyStickerResponse: true,
  });
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageEnterpriseSettings(session)) {
    return NextResponse.json({ error: "Enterprise admin access required" }, { status: 403 });
  }
  const currentShopId = Number(session.shopId);
  const enterprise = Number.isSafeInteger(currentShopId)
    ? await getEnterpriseByShopId(currentShopId)
    : null;
  const shopIds = [
    ...new Set((enterprise?.shopIds ?? []).map(Number).filter(Number.isSafeInteger)),
  ];
  if (!enterprise || !shopIds.includes(currentShopId)) {
    return NextResponse.json({ error: "Not part of an enterprise" }, { status: 400 });
  }
  const enterpriseShops = await listShopsByShopIds(shopIds);
  return NextResponse.json({
    ok: true,
    enterpriseId: String(enterprise._id ?? ""),
    currentShopId,
    shops: enterpriseShops.map((shop: any) => ({
      shopId: Number(shop.shopId),
      name: shop.name,
      locationIdentifier: shop.locationIdentifier,
      hasLogo: !!shop.stickerConfig?.logo,
      hasPhone: !!shop.stickerConfig?.phone,
      hasAppointmentUrl: !!shop.stickerConfig?.appointmentUrl,
    })),
  });
}