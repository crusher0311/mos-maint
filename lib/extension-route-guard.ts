import { NextRequest, NextResponse } from "next/server";
import {
  validateExtensionToken,
  getAuthErrorStatus,
  getUserShopIds,
} from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { getFeatureEntitlements, type FeatureKey } from "@/lib/featureResolver";

/**
 * Extension route guard.
 *
 * Centralizes the four checks every shop-scoped extension endpoint must do:
 *   1. Validate the extension token.
 *   2. Resolve the SMS shop ID to an internal mosShopId / shopDoc.
 *   3. Verify the authenticated user has access to that shop.
 *   4. (Optional) Verify the shop is entitled to one or more features.
 *
 * Platform admins bypass step 3 and step 4. Errors during the entitlement
 * lookup fail closed (we return 503 rather than rendering the feature) — this
 * matches the original gating fix shipped on the three AI/VHI extension
 * endpoints.
 *
 * Use this helper from any new extension route that needs a shop. Routes that
 * legitimately do NOT need a shop (e.g. /auth, /version) should add a
 * `// gate-exempt: <reason>` comment instead — see scripts/check-extension-gates.cjs.
 */

const DEFAULT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export interface ExtensionGuardOptions {
  /** SMS shop ID from the request body or query string. May be number/string/null. */
  smsShopId: unknown;
  /** Provider hint for the shop lookup (e.g. "tekmetric"). Defaults to "tekmetric". */
  provider?: string | null;
  /** Required feature flags. ALL listed flags must be enabled for the shop. Empty = no feature gate. */
  requiredFeatures?: FeatureKey[];
  /** CORS headers to attach to error responses. Defaults to the standard extension set. */
  corsHeaders?: Record<string, string>;
  /** Human-readable feature name used in error messages. Defaults to first requiredFeature. */
  featureLabel?: string;
}

export type ExtensionGuardResult =
  | {
      ok: true;
      user: any;
      isPlatformAdmin: boolean;
      mosShopId: number;
      shopDoc: any;
      provider: "tekmetric" | "protractor" | "shopware" | "autoflow";
    }
  | {
      ok: false;
      response: NextResponse;
    };

export async function guardExtensionShopRequest(
  request: NextRequest,
  options: ExtensionGuardOptions,
): Promise<ExtensionGuardResult> {
  const corsHeaders = options.corsHeaders ?? DEFAULT_CORS_HEADERS;

  const auth = await validateExtensionToken(request);
  if (!auth.authorized || !auth.user) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: getAuthErrorStatus(auth), headers: corsHeaders },
      ),
    };
  }

  const isPlatformAdmin =
    auth.user.role === "platform_admin" || auth.user.isPlatformAdmin === true;
  const userShopIds = getUserShopIds(auth.user);

  if (options.smsShopId === undefined || options.smsShopId === null || options.smsShopId === "") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "smsShopId required" },
        { status: 400, headers: corsHeaders },
      ),
    };
  }

  const shopResult = await findShopBySmsId(String(options.smsShopId), {
    isPlatformAdmin,
    userShopIds: userShopIds as any,
    providerHint: options.provider || "tekmetric",
  });

  if (!shopResult) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `No shop found for SMS ID: ${options.smsShopId}` },
        { status: 404, headers: corsHeaders },
      ),
    };
  }

  if (!isPlatformAdmin && !userShopIds.includes(String(shopResult.mosShopId))) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Unauthorized shop access" },
        { status: 403, headers: corsHeaders },
      ),
    };
  }

  const required = options.requiredFeatures ?? [];
  if (required.length > 0 && !isPlatformAdmin) {
    try {
      const entitlements = await getFeatureEntitlements(Number(shopResult.mosShopId));
      const eff = entitlements.effectiveFeatures;
      const missing = required.filter((f) => !eff[f]);
      if (missing.length > 0) {
        const label = options.featureLabel || missing[0];
        return {
          ok: false,
          response: NextResponse.json(
            {
              success: false,
              error: `${label} not enabled for this shop`,
              code: "feature_disabled",
              missing,
            },
            { status: 403, headers: corsHeaders },
          ),
        };
      }
    } catch (err: any) {
      console.error("[Extension Guard] feature entitlement check failed:", err?.message);
      return {
        ok: false,
        response: NextResponse.json(
          { success: false, error: "Unable to verify feature entitlement" },
          { status: 503, headers: corsHeaders },
        ),
      };
    }
  }

  return {
    ok: true,
    user: auth.user,
    isPlatformAdmin,
    mosShopId: Number(shopResult.mosShopId),
    shopDoc: shopResult.shopDoc,
    provider: shopResult.provider,
  };
}

/**
 * Lightweight feature-gate-only check, for routes that resolve their shop ID
 * through a custom path (e.g. multi-shop fallback to `auth.user.shopId`,
 * keytag/sticker which key on the authenticated user's primary shop, etc.).
 *
 * Returns `null` when the shop is entitled (or caller is platform admin).
 * Returns a NextResponse to be returned directly when denied.
 */
export async function checkShopFeatureGate(
  mosShopId: number,
  requiredFeatures: FeatureKey[],
  options: {
    isPlatformAdmin?: boolean;
    featureLabel?: string;
    corsHeaders?: Record<string, string>;
  } = {},
): Promise<NextResponse | null> {
  if (options.isPlatformAdmin) return null;
  if (!requiredFeatures || requiredFeatures.length === 0) return null;

  const corsHeaders = options.corsHeaders ?? DEFAULT_CORS_HEADERS;

  try {
    const entitlements = await getFeatureEntitlements(Number(mosShopId));
    const eff = entitlements.effectiveFeatures;
    const missing = requiredFeatures.filter((f) => !eff[f]);
    if (missing.length === 0) return null;
    const label = options.featureLabel || missing[0];
    return NextResponse.json(
      {
        success: false,
        error: `${label} not enabled for this shop`,
        code: "feature_disabled",
        missing,
      },
      { status: 403, headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("[Extension Guard] feature entitlement check failed:", err?.message);
    return NextResponse.json(
      { success: false, error: "Unable to verify feature entitlement" },
      { status: 503, headers: corsHeaders },
    );
  }
}
