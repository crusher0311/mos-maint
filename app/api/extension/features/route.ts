import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
// gate-exempt: this endpoint *reports* a shop's feature entitlements to the
// extension. Gating it on a feature would be circular — the extension calls it
// to learn which features are enabled.
import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus , buildAuthErrorBody } from "@/lib/extension-auth";
import { getFeatureEntitlements, ShopEntitlementsUnavailableError } from "@/lib/featureResolver";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { resolveInjectedButtonVisibility, INJECTED_BUTTON_PROVIDERS } from "@/lib/extension-button-visibility";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// A transient "couldn't load features right now" answer. The extension treats
// a 503 as transient: it keeps its last-known-good feature set and retries,
// instead of rendering the "not included in your subscription" lock. NEVER
// return an all-features-off 200 for a load/resolution failure — that wrongly
// locks paid features for an entitled shop.
function transientFeaturesResponse(reason: string) {
  return NextResponse.json(
    { error: reason, code: "FEATURES_TRANSIENT", transient: true },
    { status: 503, headers: corsHeaders }
  );
}

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

    if (!mosShopId && userShopIds.length === 1) {
      // Single-shop user: their only shop is unambiguous, so it's safe to use
      // even when no shop context was scraped from the page.
      mosShopId = userShopIds[0];
    }

    if (!mosShopId) {
      // Could not resolve a shop for this request. This is either:
      //   * a multi-shop user whose page context (smsShopId) was missing or
      //     didn't resolve — guessing userShopIds[0] would load the WRONG
      //     shop's entitlements/integrations/preferences, so fail CLOSED, or
      //   * a transient shop-resolution miss / degraded auth state.
      // Signal transient (503) rather than emitting an all-features-off answer:
      // the extension keeps its last-known-good feature set and retries instead
      // of switching to a wrong shop or locking an entitled shop's features.
      return transientFeaturesResponse("Could not resolve shop for features");
    }

    let entitlements: Awaited<ReturnType<typeof getFeatureEntitlements>>;
    try {
      entitlements = await getFeatureEntitlements(mosShopId, { throwIfMissing: true });
    } catch (e: any) {
      if (e instanceof ShopEntitlementsUnavailableError) {
        // Shop row couldn't be loaded this instant (DB blip / read race) even
        // though the user is authenticated for it — treat as transient.
        return transientFeaturesResponse("Entitlements temporarily unavailable");
      }
      throw e;
    }

    let integrations: string[] = [];
    let writeProvider: string | null = null;
    if (shopResult) {
      const shopDoc = shopResult.shopDoc;
      if (shopDoc.tekmetric?.shopId || shopDoc.tekmetricShopId) integrations.push("tekmetric");
      if (shopDoc.protractor?.connectionId || shopDoc.protractorConnectionId) integrations.push("protractor");
      if (shopDoc.shopware?.tenantId) integrations.push("shopware");
      // Recognize both modern nested AutoFlow config and the legacy top-level
      // `autoflowDomain` field (e.g. Harrell's NC87 → harrells-nc87.autotext.me),
      // so the reported integrations list and writeProvider resolution are
      // consistent for legacy-AutoFlow + Protractor shops.
      if (shopDoc.autoflow?.domain || shopDoc.autoflow?.subdomain || shopDoc.autoflow?.shopId || shopDoc.autoflowDomain) integrations.push("autoflow");
      
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

    // Task #1086: per-user injected-button visibility, intersected with the
    // shop's feature entitlements (hiding allowed, un-gating not). Resolved
    // for the requesting provider when known, otherwise for every provider,
    // so content scripts can consume one authoritative map.
    const userButtonVisibility = (auth.user as any)?.injectedButtonVisibility || {};
    const reqProvider = searchParams.get("provider");
    const visibilityProviders = reqProvider && INJECTED_BUTTON_PROVIDERS.includes(reqProvider)
      ? [reqProvider]
      : INJECTED_BUTTON_PROVIDERS;
    const buttonVisibility: Record<string, Record<string, boolean>> = {};
    for (const p of visibilityProviders) {
      buttonVisibility[p] = resolveInjectedButtonVisibility(p, effFeatures, userButtonVisibility);
    }

    return NextResponse.json({ 
      features: entitlements.effectiveFeatures,
      shopId: mosShopId,
      integrations,
      writeProvider,
      distanceUnit,
      floatingButtonEnabled,
      floatingButtonOwnerEnabled,
      floatingButtonUserPreference,
      buttonVisibility,
      billing: {
        plan: entitlements.billing.plan,
        status: entitlements.billing.status
      }
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Features] Error:", error);
    // Fail transient, not closed: a thrown error here must not lock the shop's
    // features. The extension keeps last-known-good and retries.
    return transientFeaturesResponse("Failed to load features");
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
