import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
// gate-exempt: extension UI preferences (toggles, layout, etc.) — not tied to
// any specific shop feature; should remain available regardless of plan.
import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus, getUserShopIds , buildAuthErrorBody } from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { getDb } from "@/lib/mongo";
import { sanitizeInjectedButtonVisibility } from "@/lib/extension-button-visibility";

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

async function _GET(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(buildAuthErrorBody(auth), { status: getAuthErrorStatus(auth), headers: corsHeaders });
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

    const floatingPref = (auth.user as any).floatingDetectDogEnabled;
    return NextResponse.json({
      defaultExtensionTab: auth.user.defaultExtensionTab || null,
      shopwareAddMode: effectiveSwMode,
      floatingDetectDogEnabled: typeof floatingPref === "boolean" ? floatingPref : null,
      // Task #1086: sparse per-provider map of injected buttons the user has
      // hidden ({ tekmetric: { enhance_notes: false }, ... }). Absent = all
      // visible. Entitlement intersection happens in the features route.
      injectedButtonVisibility: (auth.user as any).injectedButtonVisibility || {},
      shopId
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Extension Preferences] GET error:", error);
    return NextResponse.json({ error: "Failed to load preferences" }, { status: 500, headers: corsHeaders });
  }
}

async function _PUT(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(buildAuthErrorBody(auth), { status: getAuthErrorStatus(auth), headers: corsHeaders });
    }

    const body = await request.json();
    const { defaultExtensionTab, shopwareAddMode, floatingDetectDogEnabled, injectedButtonVisibility } = body;

    if (defaultExtensionTab !== undefined && defaultExtensionTab !== null && !VALID_TABS.includes(defaultExtensionTab)) {
      return NextResponse.json({ error: "Invalid tab value" }, { status: 400, headers: corsHeaders });
    }

    if (shopwareAddMode !== undefined && !VALID_SW_ADD_MODES.includes(shopwareAddMode)) {
      return NextResponse.json({ error: "Invalid Shop-Ware add mode" }, { status: 400, headers: corsHeaders });
    }

    if (
      floatingDetectDogEnabled !== undefined &&
      floatingDetectDogEnabled !== null &&
      typeof floatingDetectDogEnabled !== "boolean"
    ) {
      return NextResponse.json({ error: "Invalid floatingDetectDogEnabled value" }, { status: 400, headers: corsHeaders });
    }

    // Task #1086: validate the injected-button visibility map. null clears
    // it (back to all-visible); otherwise it must be a known-provider /
    // known-button map of booleans. Only hidden (false) entries are stored.
    let sanitizedVisibility: ReturnType<typeof sanitizeInjectedButtonVisibility> = null;
    if (injectedButtonVisibility !== undefined && injectedButtonVisibility !== null) {
      sanitizedVisibility = sanitizeInjectedButtonVisibility(injectedButtonVisibility);
      if (sanitizedVisibility === null) {
        return NextResponse.json({ error: "Invalid injectedButtonVisibility value" }, { status: 400, headers: corsHeaders });
      }
    }

    const updateFields: Record<string, any> = { updatedAt: new Date() };
    const unsetFields: Record<string, any> = {};
    if (defaultExtensionTab !== undefined) updateFields.defaultExtensionTab = defaultExtensionTab;
    if (shopwareAddMode !== undefined) updateFields.shopwareAddMode = shopwareAddMode;
    // null clears the per-user override so the user falls back to the owner /
    // shop default; a boolean records an explicit per-user choice.
    if (floatingDetectDogEnabled === null) {
      unsetFields.floatingDetectDogEnabled = "";
    } else if (typeof floatingDetectDogEnabled === "boolean") {
      updateFields.floatingDetectDogEnabled = floatingDetectDogEnabled;
    }
    if (injectedButtonVisibility === null) {
      unsetFields.injectedButtonVisibility = "";
    } else if (sanitizedVisibility !== null) {
      updateFields.injectedButtonVisibility = sanitizedVisibility;
    }

    const updateOps: Record<string, any> = { $set: updateFields };
    if (Object.keys(unsetFields).length > 0) updateOps.$unset = unsetFields;

    const db = await getDb();
    await db.collection("users").updateOne(
      { _id: auth.user._id },
      updateOps
    );

    return NextResponse.json({ 
      success: true, 
      defaultExtensionTab: defaultExtensionTab ?? auth.user.defaultExtensionTab,
      shopwareAddMode: shopwareAddMode ?? auth.user.shopwareAddMode ?? "finding-published",
      floatingDetectDogEnabled: floatingDetectDogEnabled === undefined
        ? ((auth.user as any).floatingDetectDogEnabled ?? null)
        : floatingDetectDogEnabled,
      injectedButtonVisibility: injectedButtonVisibility === undefined
        ? ((auth.user as any).injectedButtonVisibility || {})
        : (sanitizedVisibility || {})
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Extension Preferences] PUT error:", error);
    return NextResponse.json({ error: "Failed to save preference" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
export const PUT = withExtensionErrorMarker(_PUT as any);
