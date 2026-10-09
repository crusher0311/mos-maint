import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { readShopBranding, replaceSharedSettingsForShop } from "@/lib/data/repositories/shops";

export async function GET() {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);
    const shop = await readShopBranding(shopId);

    // Determine SMS type for fallback logo
    let smsType = "none";
    if (shop.smsType === "tekmetric") {
      smsType = "tekmetric";
    } else if (shop.smsType === "protractor") {
      smsType = "protractor";
    }

    // Use Tekmetric logo as fallback only if: Tekmetric integration + no custom logo
    const hasCustomLogo = Boolean(shop.logo);
    const isTekmetric = smsType === "tekmetric";
    const fallbackLogo = (!hasCustomLogo && isTekmetric) ? "/tekmetric-logo.png" : null;

    return NextResponse.json({
      logo: shop.logo,
      fallbackLogo,
      shopName: shop.displayName,
      locationIdentifier: shop?.locationIdentifier || null,
      smsType,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: any) {
    console.error("Error fetching branding:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);

    const body = await req.json();
    const { logo, displayName, locationIdentifier } = body;

    if (logo && typeof logo === "string") {
      if (!logo.startsWith("data:image/")) {
        return NextResponse.json({ error: "Invalid image format. Please upload a valid image." }, { status: 400 });
      }
      const sizeInBytes = Buffer.byteLength(logo, "utf8");
      const maxSize = 500 * 1024;
      if (sizeInBytes > maxSize) {
        return NextResponse.json({ error: "Image too large. Please use an image under 500KB." }, { status: 400 });
      }
    }

    const updateFields: Record<string, any> = {};
    if (logo !== undefined) {
      updateFields["branding.logo"] = logo;
    }
    if (displayName !== undefined) {
      updateFields["branding.displayName"] = displayName;
    }
    if (locationIdentifier !== undefined) {
      updateFields["locationIdentifier"] = locationIdentifier;
    }

    const result = await replaceSharedSettingsForShop(shopId, updateFields);
    if (result.matchedCount !== 1) return NextResponse.json({ error: "Shop not found" }, { status: 404 });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("Error saving branding:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);

    const result = await replaceSharedSettingsForShop(shopId, { "branding.logo": null });
    if (result.matchedCount !== 1) return NextResponse.json({ error: "Shop not found" }, { status: 404 });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("Error deleting logo:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
