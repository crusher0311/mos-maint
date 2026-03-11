import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus, getUserShopIds } from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { getDb } from "@/lib/mongo";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const VALID_TABS = ["plan", "failures", "lookup", "canned", "rates", "sticker"];
const VALID_SW_ADD_MODES = ["finding-published", "finding-draft", "add-service"];

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: getAuthErrorStatus(auth), headers: corsHeaders });
    }

    const searchParams = request.nextUrl.searchParams;
    const smsShopId = searchParams.get("shopId");
    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    const db = await getDb();
    let shopId = auth.user.shopId;

    if (smsShopId) {
      const provider = searchParams.get("provider") || undefined;
      const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin, providerHint: provider });
      if (!shopResult) {
        return NextResponse.json({ error: `No accessible shop configured for SMS shop ID ${smsShopId}` }, { status: 404, headers: corsHeaders });
      }
      shopId = shopResult.mosShopId;
    }

    const shop = await db.collection("shops").findOne({ shopId });
    const shopSwMode = shop?.preferences?.shopwareAddMode || "finding-published";
    const effectiveSwMode = smsShopId ? shopSwMode : (auth.user.shopwareAddMode || shopSwMode);

    return NextResponse.json({
      defaultExtensionTab: auth.user.defaultExtensionTab || null,
      shopwareAddMode: effectiveSwMode,
      shopId
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Extension Preferences] GET error:", error);
    return NextResponse.json({ error: "Failed to load preferences" }, { status: 500, headers: corsHeaders });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: getAuthErrorStatus(auth), headers: corsHeaders });
    }

    const body = await request.json();
    const { defaultExtensionTab, shopwareAddMode } = body;

    if (defaultExtensionTab !== undefined && defaultExtensionTab !== null && !VALID_TABS.includes(defaultExtensionTab)) {
      return NextResponse.json({ error: "Invalid tab value" }, { status: 400, headers: corsHeaders });
    }

    if (shopwareAddMode !== undefined && !VALID_SW_ADD_MODES.includes(shopwareAddMode)) {
      return NextResponse.json({ error: "Invalid Shop-Ware add mode" }, { status: 400, headers: corsHeaders });
    }

    const updateFields: Record<string, any> = { updatedAt: new Date() };
    if (defaultExtensionTab !== undefined) updateFields.defaultExtensionTab = defaultExtensionTab;
    if (shopwareAddMode !== undefined) updateFields.shopwareAddMode = shopwareAddMode;

    const db = await getDb();
    await db.collection("users").updateOne(
      { _id: auth.user._id },
      { $set: updateFields }
    );

    return NextResponse.json({ 
      success: true, 
      defaultExtensionTab: defaultExtensionTab ?? auth.user.defaultExtensionTab,
      shopwareAddMode: shopwareAddMode ?? auth.user.shopwareAddMode ?? "finding-published"
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Extension Preferences] PUT error:", error);
    return NextResponse.json({ error: "Failed to save preference" }, { status: 500, headers: corsHeaders });
  }
}
