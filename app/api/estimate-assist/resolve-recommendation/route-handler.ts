import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import {
  buildAuthErrorBody,
  getAuthErrorStatus,
  isExtensionBearerRequest,
  validateExtensionToken,
} from "@/lib/extension-auth";
import {
  rehydrateRecommendationSelection,
  resolveRecommendation,
} from "@/lib/estimate-assist/recommendation-resolver";
import type {
  AuditSelection,
  RecommendationFinding,
  RecommendationResolveOptions,
  RecommendationVehicle,
} from "@/lib/estimate-assist/recommendation-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/**
 * Route seam used by backend smoke tests.  Keeping auth and entitlement
 * dependencies here (rather than in the client-safe contract module) also
 * makes it difficult for a browser payload to bypass the server scope.
 */
export const __deps = {
  getSession,
  validateExtensionToken,
  getFeatureEntitlements,
  resolveRecommendation,
  rehydrateRecommendationSelection,
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function featureDenied(entitlements: any, feature: "estimate_assist" | "job_lookup") {
  return !entitlements || typeof entitlements.canUseFeature !== "function" ||
    !entitlements.canUseFeature(feature);
}

export async function POST(req: NextRequest) {
  try {
    let shopId: number;
    let sessionEmail: string | null = null;

    // Match the Estimate Audit / Job Builder dual-auth contract: dashboard
    // cookies and extension bearer tokens are both valid, but extension
    // tokens must be validated by this route rather than trusted as claims.
    if (isExtensionBearerRequest(req)) {
      const auth = await __deps.validateExtensionToken(req);
      if (!auth.authorized || !auth.user) {
        return NextResponse.json(
          buildAuthErrorBody(auth, { ok: false }),
          { status: getAuthErrorStatus(auth), headers: corsHeaders },
        );
      }
      shopId = Number(auth.user.shopId);
      sessionEmail = auth.user.email || null;
    } else {
      const session = await __deps.getSession();
      if (!session) {
        return NextResponse.json(
          { ok: false, error: "Unauthorized" },
          { status: 401, headers: corsHeaders },
        );
      }
      shopId = Number(session.shopId);
      sessionEmail = session.email || null;
    }
    void sessionEmail;

    if (!Number.isFinite(shopId) || shopId <= 0) {
      return NextResponse.json(
        { ok: false, error: "No shop associated with this account" },
        { status: 400, headers: corsHeaders },
      );
    }

    const entitlements = await __deps.getFeatureEntitlements(shopId);
    // Resolution can expose historical price/line details, so it is gated
    // both by Estimate Assist (the audit action) and Job Lookup (the
    // historical/canned-job data surface).
    if (featureDenied(entitlements, "estimate_assist")) {
      return NextResponse.json(
        {
          ok: false,
          error: "Estimate Assist is not available on your current plan",
          code: "FEATURE_NOT_AVAILABLE",
          feature: "estimate_assist",
          upgradeRequired: true,
          currentPlan: entitlements?.billing?.plan,
        },
        { status: 402, headers: corsHeaders },
      );
    }
    if (featureDenied(entitlements, "job_lookup")) {
      return NextResponse.json(
        {
          ok: false,
          error: "Job Lookup is not available on your current plan",
          code: "FEATURE_NOT_AVAILABLE",
          feature: "job_lookup",
          upgradeRequired: true,
          currentPlan: entitlements?.billing?.plan,
        },
        { status: 402, headers: corsHeaders },
      );
    }

    const body = await req.json();

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

    const finding = body?.finding as RecommendationFinding | undefined;
    const rawSelection = body?.selection || body?.auditSelection;
    const previewMode: RecommendationResolveOptions["mode"] =
      body?.mode === "preview" || body?.mode === "selected_detail" || rawSelection
        ? "preview"
        : "search";
    const selection: AuditSelection | undefined =
      rawSelection && typeof rawSelection === "object"
        ? rawSelection.source
          ? rawSelection as AuditSelection
          : { source: rawSelection.sourceIdentity || rawSelection }
        : undefined;
    const normalizedFinding =
      finding && typeof finding === "object" &&
      typeof finding.suggestedJobTitle === "string" &&
      finding.suggestedJobTitle.trim()
        ? finding
        : previewMode === "preview" && selection?.source?.title
          ? { suggestedJobTitle: selection.source.title }
          : undefined;
    if (!normalizedFinding) {
      return NextResponse.json(
        { ok: false, error: "finding.suggestedJobTitle is required" },
        { status: 400, headers: corsHeaders },
      );
    }
    if (previewMode === "preview" && !selection?.source) {
      return NextResponse.json(
        { ok: false, error: "selection.source is required for selected-detail preview" },
        { status: 400, headers: corsHeaders },
      );
    }

    const resolution = await __deps.resolveRecommendation(
      shopId,
      {
        suggestedJobTitle: normalizedFinding.suggestedJobTitle.slice(0, 180),
        suggestedJobId: typeof normalizedFinding.suggestedJobId === "string"
          ? normalizedFinding.suggestedJobId.slice(0, 120)
          : null,
      },
      vehicle,
      previewMode === "preview"
        ? { mode: previewMode, selection }
        : undefined,
    );

    return NextResponse.json(
      {
        ok: true,
        resolution,
        ...(previewMode === "preview" && Array.isArray(resolution.candidates) && resolution.candidates[0]
          ? { candidate: resolution.candidates[0] }
          : {}),
      },
      { headers: corsHeaders },
    );
  } catch (error: any) {
    console.error("[Estimate Assist] Recommendation resolution failed:", error);
    return NextResponse.json(
      { ok: false, error: "Recommendation lookup is temporarily unavailable" },
      { status: 503, headers: corsHeaders },
    );
  }
}
