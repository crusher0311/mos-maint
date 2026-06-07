import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
// gate-exempt: this endpoint *reports* a shop's feature entitlements to the
// extension. Gating it on a feature would be circular — the extension calls it
// to learn which features are enabled.
import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus , buildAuthErrorBody } from "@/lib/extension-auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const smsShopId = searchParams.get("shopId");

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      console.log(`[Extension Features] AUTH FAIL: smsShopId=${smsShopId}, error=${auth.error}`);
      return NextResponse.json(buildAuthErrorBody(auth), { status: getAuthErrorStatus(auth), headers: corsHeaders });
    }

    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    let mosShopId: number | null = null;
    let shopResult: Awaited<ReturnType<typeof findShopBySmsId>> = null;
    
    if (smsShopId) {
      const provider = searchParams.get("provider") || undefined;
      shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin, providerHint: provider });
      if (shopResult) {
        mosShopId = shopResult.mosShopId;
      }
    }

    if (!mosShopId && userShopIds.length > 0) {
      mosShopId = userShopIds[0];
    }

    if (!mosShopId) {
      return NextResponse.json({
        features: {
          maintenance: false,
          job_lookup: false,
          common_failures: false,
          oil_sticker: false,
          keytags: false,
          auto_booking: false,
          part_xref: false,
          concern_assistant: false,
          estimate_assist: false,
          dvi_prefill: false,
          enhance_notes: false
        }
      }, { headers: corsHeaders });
    }

    const entitlements = await getFeatureEntitlements(mosShopId);

    let integrations: string[] = [];
    let writeProvider: string | null = null;
    if (shopResult) {
      const shopDoc = shopResult.shopDoc;
      if (shopDoc.tekmetric?.shopId || shopDoc.tekmetricShopId) integrations.push("tekmetric");
      if (shopDoc.protractor?.connectionId || shopDoc.protractorConnectionId) integrations.push("protractor");
      if (shopDoc.shopware?.tenantId) integrations.push("shopware");
      if (shopDoc.autoflow?.domain || shopDoc.autoflow?.subdomain || shopDoc.autoflow?.shopId) integrations.push("autoflow");
      
      const provider = searchParams.get("provider");
      if (provider === "autoflow") {
        const writeInt = integrations.find(i => i !== "autoflow");
        if (writeInt) writeProvider = writeInt;
      }
    }

    // Task #340: surface the shop's distance preference so the side-panel
    // renderer can label hardcoded "mi" strings (mileage chip, last-done
    // tooltips, interval/dueAt/overdue text) in the right unit before the
    // plan response arrives.
    const shopDoc = shopResult?.shopDoc as any;
    const distanceUnit: "miles" | "kilometers" =
      (shopDoc?.preferences?.distanceUnit ?? shopDoc?.settings?.distanceUnit) === "kilometers"
        ? "kilometers"
        : "miles";

    // Floating "Detect Dog" launcher button visibility. Two independent
    // switches resolve to one effective on/off the content scripts honor:
    //   * Owner (per-shop): shops.preferences.floatingDetectDogEnabled.
    //     When unset, defaults OFF for shops whose only enabled features are
    //     oil stickers / keytags, otherwise ON.
    //   * User (per-account): users.floatingDetectDogEnabled. When unset,
    //     defaults ON. A user may turn it off for themselves, but the owner's
    //     OFF is a hard gate the user cannot override.
    const effFeatures = (entitlements.effectiveFeatures || {}) as Record<string, boolean>;
    const enabledFeatureKeys = Object.keys(effFeatures).filter((k) => effFeatures[k]);
    const STICKER_KEYTAG_ONLY = new Set(["oil_sticker", "keytags"]);
    const onlyStickerKeytag =
      enabledFeatureKeys.length > 0 &&
      enabledFeatureKeys.every((k) => STICKER_KEYTAG_ONLY.has(k));

    const ownerPref = shopDoc?.preferences?.floatingDetectDogEnabled;
    const floatingButtonOwnerEnabled =
      typeof ownerPref === "boolean" ? ownerPref : !onlyStickerKeytag;

    const userPref = (auth.user as any)?.floatingDetectDogEnabled;
    const floatingButtonUserPreference =
      typeof userPref === "boolean" ? userPref : null;
    const userResolved = floatingButtonUserPreference === null ? true : floatingButtonUserPreference;

    const floatingButtonEnabled = floatingButtonOwnerEnabled && userResolved;

    return NextResponse.json({ 
      features: entitlements.effectiveFeatures,
      shopId: mosShopId,
      integrations,
      writeProvider,
      distanceUnit,
      floatingButtonEnabled,
      floatingButtonOwnerEnabled,
      floatingButtonUserPreference,
      billing: {
        plan: entitlements.billing.plan,
        status: entitlements.billing.status
      }
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Features] Error:", error);
    return NextResponse.json(
      { error: "Failed to load features" },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
