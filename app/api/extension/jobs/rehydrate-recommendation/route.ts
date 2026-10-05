import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import {
  buildAuthErrorBody,
  getAuthErrorStatus,
  getUserShopIds,
  requireExtensionPrincipalScope,
  validateExtensionToken,
} from "@/lib/extension-auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import {
  rehydrateRecommendationSelection,
} from "@/lib/estimate-assist/recommendation-resolver";
import type {
  AuditSelection,
  RecommendationVehicle,
} from "@/lib/estimate-assist/recommendation-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * Rehydrates the selected audit source immediately before a direct provider
 * write.  The extension's preview is never accepted as authoritative job
 * content: provider adapters receive only the current server-side source
 * details returned here.
 */
async function _POST(req: NextRequest) {
  try {
    const auth = await validateExtensionToken(req);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        buildAuthErrorBody(auth),
        { status: getAuthErrorStatus(auth), headers: corsHeaders },
      );
    }

    const body = await req.json();
    const shopId = Number(body?.shopId);
    const provider = String(body?.provider || "protractor")
      .toLowerCase()
      .replace(/^shop[-_]ware$/, "shopware");

    if (!Number.isFinite(shopId) || shopId <= 0) {
      return NextResponse.json(
        { ok: false, error: "shopId is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const userShopIds = getUserShopIds(auth.user).map(Number);
    const isPlatformAdmin = auth.user.role === "platform_admin";
    if (!isPlatformAdmin && !userShopIds.includes(shopId)) {
      return NextResponse.json(
        { ok: false, error: "Not authorized for this shop" },
        { status: 403, headers: corsHeaders },
      );
    }

    if (!["protractor", "autoflow", "tekmetric", "shopware", "shopmonkey"].includes(provider)) {
      return NextResponse.json(
        { ok: false, error: "Provider scope mismatch", code: "PROVIDER_FORBIDDEN" },
        { status: 403, headers: corsHeaders },
      );
    }
    const scopeFailure = requireExtensionPrincipalScope(auth, { shopId, provider });
    if (scopeFailure) {
      return NextResponse.json(
        buildAuthErrorBody(scopeFailure),
        { status: getAuthErrorStatus(scopeFailure), headers: corsHeaders },
      );
    }

    const entitlements = await getFeatureEntitlements(shopId);
    if (!entitlements.canUseFeature("estimate_assist") || !entitlements.canUseFeature("job_lookup")) {
      return NextResponse.json(
        {
          ok: false,
          error: "Estimate Assist and Job Lookup are required for selected-source writes",
          code: "FEATURE_NOT_AVAILABLE",
          feature: "estimate_assist",
          upgradeRequired: true,
          currentPlan: entitlements.billing.plan,
        },
        { status: 402, headers: corsHeaders },
      );
    }

    const rawSelection = body?.auditSelection;
    const expectedTitle = typeof body?.auditFinding?.suggestedJobTitle === "string"
      ? body.auditFinding.suggestedJobTitle.slice(0, 180)
      : undefined;
    const selection: AuditSelection | null = rawSelection?.source
      ? rawSelection as AuditSelection
      : rawSelection?.sourceIdentity
        ? { source: rawSelection.sourceIdentity }
        : rawSelection && typeof rawSelection === "object"
          ? { source: rawSelection }
          : null;
    if (!selection) {
      return NextResponse.json(
        { ok: false, error: "auditSelection.source is required" },
        { status: 400, headers: corsHeaders },
      );
    }
    if (!expectedTitle) {
      return NextResponse.json(
        { ok: false, error: "auditFinding.suggestedJobTitle is required to bind the source" },
        { status: 400, headers: corsHeaders },
      );
    }

    const rawVehicle = body?.vehicle;
    const vehicle: RecommendationVehicle = rawVehicle && typeof rawVehicle === "object"
      ? {
          vin: typeof rawVehicle.vin === "string" ? rawVehicle.vin.slice(0, 32) : undefined,
          year: typeof rawVehicle.year === "number" || typeof rawVehicle.year === "string" ? rawVehicle.year : undefined,
          make: typeof rawVehicle.make === "string" ? rawVehicle.make.slice(0, 80) : undefined,
          model: typeof rawVehicle.model === "string" ? rawVehicle.model.slice(0, 80) : undefined,
          engine: typeof rawVehicle.engine === "string" ? rawVehicle.engine.slice(0, 120) : undefined,
        }
      : {};
    const hydrated = await rehydrateRecommendationSelection(shopId, selection, vehicle, { expectedTitle });
    if (!hydrated.ok) {
      const status = hydrated.code === "FORBIDDEN" ? 403 : hydrated.code === "UNAVAILABLE" ? 503 : 404;
      return NextResponse.json(
        { ok: false, error: hydrated.error, code: hydrated.code },
        { status, headers: corsHeaders },
      );
    }

    return NextResponse.json(
      { ok: true, recommendation: hydrated.recommendation },
      { headers: corsHeaders },
    );
  } catch (error: any) {
    console.error("[Ext Rehydrate Recommendation] Error:", error?.message || error);
    return NextResponse.json(
      { ok: false, error: "Selected recommendation is temporarily unavailable" },
      { status: 503, headers: corsHeaders },
    );
  }
}

export const POST = withExtensionErrorMarker(_POST as any);