import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const dynamic = "force-dynamic";

interface CopyRequest {
  sourceShopId: number;
  targetShopIds: number[];
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userRole = session.role;
  const isPlatformAdmin = session.isPlatformAdmin;
  const isImpersonation = session.isImpersonation;
  const allowedRoles = ["enterprise_admin", "admin", "owner"];
  if (!allowedRoles.includes(userRole) && !isPlatformAdmin && !isImpersonation) {
    return NextResponse.json({ error: "Enterprise admin access required" }, { status: 403 });
  }

  try {
    const body: CopyRequest = await req.json();
    const { sourceShopId, targetShopIds } = body;

    if (!sourceShopId || !targetShopIds || targetShopIds.length === 0) {
      return NextResponse.json({ error: "Source shop and target shops are required" }, { status: 400 });
    }

    const userShopId = String(session.shopId);
    const userShopRows = await sql`
      SELECT id, settings FROM shops WHERE shop_id = ${userShopId} LIMIT 1
    `;
    const userShop = userShopRows[0];

    if (!userShop?.settings?.enterpriseId) {
      return NextResponse.json({ error: "You are not part of an enterprise" }, { status: 403 });
    }

    const sourceShopRows = await sql`
      SELECT id, name, settings FROM shops WHERE shop_id = ${String(sourceShopId)} LIMIT 1
    `;
    const sourceShop = sourceShopRows[0];

    if (!sourceShop) {
      return NextResponse.json({ error: "Source shop not found" }, { status: 404 });
    }

    const userEnterpriseId = String(userShop.settings.enterpriseId);
    const sourceEnterpriseId = String(sourceShop.settings?.enterpriseId);
    
    if (sourceEnterpriseId !== userEnterpriseId) {
      console.error(`[Copy Sticker] Enterprise mismatch: user=${userEnterpriseId}, source=${sourceEnterpriseId}, userShopId=${userShopId}, sourceShopId=${sourceShopId}`);
      return NextResponse.json({ error: "Source shop is not in your enterprise" }, { status: 403 });
    }

    const enterpriseId = sourceShop.settings.enterpriseId;
    const targetShopIdsStr = targetShopIds.map(String);

    const targetShops = await sql`
      SELECT id, shop_id, name, settings FROM shops 
      WHERE shop_id = ANY(${targetShopIdsStr}) 
        AND settings->>'enterpriseId' = ${String(enterpriseId)}
    `;

    if (targetShops.length === 0) {
      return NextResponse.json({ error: "No valid target shops found in the same enterprise" }, { status: 400 });
    }

    const sourceConfig = sourceShop.settings?.stickerConfig || {};

    const settingsToCopy: Record<string, any> = {};

    if (sourceConfig.logo) settingsToCopy.logo = sourceConfig.logo;
    if (sourceConfig.logoObjectPath) settingsToCopy.logoObjectPath = sourceConfig.logoObjectPath;
    if (sourceConfig.tagline) settingsToCopy.tagline = sourceConfig.tagline;
    if (sourceConfig.taglineLine2) settingsToCopy.taglineLine2 = sourceConfig.taglineLine2;
    if (sourceConfig.serviceLabel) settingsToCopy.serviceLabel = sourceConfig.serviceLabel;
    if (sourceConfig.fontStyles) settingsToCopy.fontStyles = sourceConfig.fontStyles;
    if (sourceConfig.colors) settingsToCopy.colors = sourceConfig.colors;
    if (sourceConfig.useKilometers !== undefined) settingsToCopy.useKilometers = sourceConfig.useKilometers;
    if (sourceConfig.roundMileage !== undefined) settingsToCopy.roundMileage = sourceConfig.roundMileage;
    if (sourceConfig.designerLayout) settingsToCopy.designerLayout = sourceConfig.designerLayout;
    if (sourceConfig.defaultSize) settingsToCopy.defaultSize = sourceConfig.defaultSize;
    if (sourceConfig.showQRCode !== undefined) settingsToCopy.showQRCode = sourceConfig.showQRCode;
    if (sourceConfig.usePredictiveDate !== undefined) settingsToCopy.usePredictiveDate = sourceConfig.usePredictiveDate;
    if (sourceConfig.intervals) settingsToCopy.intervals = sourceConfig.intervals;
    if (sourceConfig.defaultOilType) settingsToCopy.defaultOilType = sourceConfig.defaultOilType;

    if (Object.keys(settingsToCopy).length === 0) {
      return NextResponse.json({ error: "No sticker settings to copy from source shop" }, { status: 400 });
    }

    const sourceLogoRows = await sql`
      SELECT * FROM shop_media WHERE shop_id = ${String(sourceShopId)} AND type = 'logo' LIMIT 1
    `;
    const sourceLogo = sourceLogoRows[0];

    const results: { shopId: number; shopName: string; success: boolean; error?: string }[] = [];

    for (const targetShop of targetShops) {
      const targetShopId = Number(targetShop.shop_id);

      if (targetShopId === sourceShopId) {
        continue;
      }

      try {
        const currentSettings = targetShop.settings || {};
        const currentStickerConfig = currentSettings.stickerConfig || {};
        const updatedStickerConfig = { ...currentStickerConfig, ...settingsToCopy };
        const updatedSettings = { ...currentSettings, stickerConfig: updatedStickerConfig };

        await sql`
          UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb
          WHERE id = ${targetShop.id}
        `;

        if (sourceLogo?.data_uri) {
          await sql`
            INSERT INTO shop_media (shop_id, type, data_uri, content_type, updated_at)
            VALUES (${String(targetShopId)}, 'logo', ${sourceLogo.data_uri}, ${sourceLogo.content_type || 'image/png'}, NOW())
            ON CONFLICT (shop_id, type) DO UPDATE SET
              data_uri = ${sourceLogo.data_uri},
              content_type = ${sourceLogo.content_type || 'image/png'},
              updated_at = NOW()
          `;
        }

        results.push({
          shopId: targetShopId,
          shopName: targetShop.name || `Shop ${targetShopId}`,
          success: true,
        });
      } catch (err) {
        console.error(`Error copying to shop ${targetShopId}:`, err);
        results.push({
          shopId: targetShopId,
          shopName: targetShop.name || `Shop ${targetShopId}`,
          success: false,
          error: "Failed to copy settings",
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    return NextResponse.json({
      ok: true,
      message: `Copied sticker settings to ${successCount} location(s)${failCount > 0 ? `, ${failCount} failed` : ""}`,
      results,
      copiedFields: Object.keys(settingsToCopy),
      preservedFields: ["phone", "appointmentUrl", "hovercodeQRId", "cachedQrCodeDataUri"],
    });
  } catch (error) {
    console.error("Error copying sticker settings:", error);
    return NextResponse.json({ error: "Failed to copy sticker settings" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userRole = session.role;
  const isPlatformAdmin = session.isPlatformAdmin;
  const isImpersonation = session.isImpersonation;
  const allowedRoles = ["enterprise_admin", "admin", "owner"];
  if (!allowedRoles.includes(userRole) && !isPlatformAdmin && !isImpersonation) {
    return NextResponse.json({ error: "Enterprise admin access required" }, { status: 403 });
  }

  try {
    const currentShopId = String(session.shopId);

    const currentShopRows = await sql`
      SELECT settings FROM shops WHERE shop_id = ${currentShopId} LIMIT 1
    `;
    const currentShop = currentShopRows[0];

    if (!currentShop?.settings?.enterpriseId) {
      return NextResponse.json({ error: "Not part of an enterprise" }, { status: 400 });
    }

    const enterpriseId = String(currentShop.settings.enterpriseId);

    const enterpriseShops = await sql`
      SELECT shop_id, name, settings FROM shops 
      WHERE settings->>'enterpriseId' = ${enterpriseId}
    `;

    const shops = enterpriseShops.map((shop: any) => ({
      shopId: Number(shop.shop_id),
      name: shop.name,
      locationIdentifier: shop.settings?.locationIdentifier,
      hasLogo: !!shop.settings?.stickerConfig?.logo,
      hasPhone: !!shop.settings?.stickerConfig?.phone,
      hasAppointmentUrl: !!shop.settings?.stickerConfig?.appointmentUrl,
    }));

    return NextResponse.json({
      ok: true,
      enterpriseId: currentShop.settings.enterpriseId,
      currentShopId: Number(currentShopId),
      shops,
    });
  } catch (error) {
    console.error("Error fetching enterprise shops:", error);
    return NextResponse.json({ error: "Failed to fetch shops" }, { status: 500 });
  }
}
