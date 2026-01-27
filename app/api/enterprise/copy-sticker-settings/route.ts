import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

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
  if (userRole !== "enterprise_admin" && userRole !== "admin" && !isPlatformAdmin && !isImpersonation) {
    return NextResponse.json({ error: "Enterprise admin access required" }, { status: 403 });
  }

  try {
    const body: CopyRequest = await req.json();
    const { sourceShopId, targetShopIds } = body;

    if (!sourceShopId || !targetShopIds || targetShopIds.length === 0) {
      return NextResponse.json({ error: "Source shop and target shops are required" }, { status: 400 });
    }

    const db = await getDb();

    const userShopId = Number(session.shopId);
    const userShop = await db.collection("shops").findOne({
      shopId: { $in: [userShopId, String(userShopId)] },
    });

    if (!userShop?.enterpriseId) {
      return NextResponse.json({ error: "You are not part of an enterprise" }, { status: 403 });
    }

    const sourceShop = await db.collection("shops").findOne({
      shopId: { $in: [sourceShopId, String(sourceShopId)] },
    });

    if (!sourceShop) {
      return NextResponse.json({ error: "Source shop not found" }, { status: 404 });
    }

    if (sourceShop.enterpriseId !== userShop.enterpriseId) {
      return NextResponse.json({ error: "Source shop is not in your enterprise" }, { status: 403 });
    }

    const enterpriseId = sourceShop.enterpriseId;

    const targetShops = await db.collection("shops").find({
      shopId: { $in: targetShopIds.flatMap(id => [id, String(id)]) },
      enterpriseId: enterpriseId,
    }).toArray();

    if (targetShops.length === 0) {
      return NextResponse.json({ error: "No valid target shops found in the same enterprise" }, { status: 400 });
    }

    const sourceConfig = sourceShop.stickerConfig || {};

    const settingsToCopy: Record<string, any> = {};

    if (sourceConfig.logo) {
      settingsToCopy["stickerConfig.logo"] = sourceConfig.logo;
    }
    if (sourceConfig.logoObjectPath) {
      settingsToCopy["stickerConfig.logoObjectPath"] = sourceConfig.logoObjectPath;
    }
    if (sourceConfig.tagline) {
      settingsToCopy["stickerConfig.tagline"] = sourceConfig.tagline;
    }
    if (sourceConfig.taglineLine2) {
      settingsToCopy["stickerConfig.taglineLine2"] = sourceConfig.taglineLine2;
    }
    if (sourceConfig.serviceLabel) {
      settingsToCopy["stickerConfig.serviceLabel"] = sourceConfig.serviceLabel;
    }
    if (sourceConfig.fontStyles) {
      settingsToCopy["stickerConfig.fontStyles"] = sourceConfig.fontStyles;
    }
    if (sourceConfig.colors) {
      settingsToCopy["stickerConfig.colors"] = sourceConfig.colors;
    }
    if (sourceConfig.useKilometers !== undefined) {
      settingsToCopy["stickerConfig.useKilometers"] = sourceConfig.useKilometers;
    }
    if (sourceConfig.roundMileage !== undefined) {
      settingsToCopy["stickerConfig.roundMileage"] = sourceConfig.roundMileage;
    }
    if (sourceConfig.designerLayout) {
      settingsToCopy["stickerConfig.designerLayout"] = sourceConfig.designerLayout;
    }
    if (sourceConfig.defaultSize) {
      settingsToCopy["stickerConfig.defaultSize"] = sourceConfig.defaultSize;
    }
    if (sourceConfig.showQRCode !== undefined) {
      settingsToCopy["stickerConfig.showQRCode"] = sourceConfig.showQRCode;
    }
    if (sourceConfig.usePredictiveDate !== undefined) {
      settingsToCopy["stickerConfig.usePredictiveDate"] = sourceConfig.usePredictiveDate;
    }
    if (sourceConfig.intervals) {
      settingsToCopy["stickerConfig.intervals"] = sourceConfig.intervals;
    }
    if (sourceConfig.defaultOilType) {
      settingsToCopy["stickerConfig.defaultOilType"] = sourceConfig.defaultOilType;
    }

    if (Object.keys(settingsToCopy).length === 0) {
      return NextResponse.json({ error: "No sticker settings to copy from source shop" }, { status: 400 });
    }

    const sourceLogo = await db.collection("shop_media").findOne({
      shopId: sourceShopId,
      type: "logo",
    });

    const results: { shopId: number; shopName: string; success: boolean; error?: string }[] = [];

    for (const targetShop of targetShops) {
      const targetShopId = typeof targetShop.shopId === "string" 
        ? parseInt(targetShop.shopId, 10) 
        : targetShop.shopId;

      if (targetShopId === sourceShopId) {
        continue;
      }

      try {
        await db.collection("shops").updateOne(
          { _id: targetShop._id },
          { $set: settingsToCopy }
        );

        if (sourceLogo?.dataUri) {
          await db.collection("shop_media").updateOne(
            { shopId: targetShopId, type: "logo" },
            {
              $set: {
                shopId: targetShopId,
                type: "logo",
                dataUri: sourceLogo.dataUri,
                contentType: sourceLogo.contentType || "image/png",
                updatedAt: new Date(),
              },
            },
            { upsert: true }
          );
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
      copiedFields: Object.keys(settingsToCopy).map(k => k.replace("stickerConfig.", "")),
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
  if (userRole !== "enterprise_admin" && userRole !== "admin" && !isPlatformAdmin && !isImpersonation) {
    return NextResponse.json({ error: "Enterprise admin access required" }, { status: 403 });
  }

  try {
    const db = await getDb();
    const currentShopId = Number(session.shopId);

    const currentShop = await db.collection("shops").findOne({
      shopId: { $in: [currentShopId, String(currentShopId)] },
    });

    if (!currentShop?.enterpriseId) {
      return NextResponse.json({ error: "Not part of an enterprise" }, { status: 400 });
    }

    const enterpriseShops = await db.collection("shops").find({
      enterpriseId: currentShop.enterpriseId,
    }).project({
      shopId: 1,
      name: 1,
      locationIdentifier: 1,
      "stickerConfig.logo": 1,
      "stickerConfig.phone": 1,
      "stickerConfig.appointmentUrl": 1,
    }).toArray();

    const shops = enterpriseShops.map(shop => ({
      shopId: typeof shop.shopId === "string" ? parseInt(shop.shopId, 10) : shop.shopId,
      name: shop.name,
      locationIdentifier: shop.locationIdentifier,
      hasLogo: !!shop.stickerConfig?.logo,
      hasPhone: !!shop.stickerConfig?.phone,
      hasAppointmentUrl: !!shop.stickerConfig?.appointmentUrl,
    }));

    return NextResponse.json({
      ok: true,
      enterpriseId: currentShop.enterpriseId,
      currentShopId,
      shops,
    });
  } catch (error) {
    console.error("Error fetching enterprise shops:", error);
    return NextResponse.json({ error: "Failed to fetch shops" }, { status: 500 });
  }
}
