import { NextRequest, NextResponse } from "next/server";
import {
  getAuthErrorStatus,
  buildAuthErrorBody,
  isExtensionBearerRequest,
} from "@/lib/extension-auth";
import {
  auditAutomationUnavailableReason,
  statusFromAuditState,
  type AuditProvider,
} from "@/lib/estimate-assist/audit-automation";
import { canAccessShopFeature } from "@/lib/shop-feature-access";
import { summarizeFindings } from "@/lib/estimate-assist/audit-engine";
import { auditStatusDeps } from "./deps";

export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const PROVIDERS = new Set<AuditProvider>(["tekmetric", "protractor", "shopware", "shopmonkey"]);

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * Cheap current-RO read. It only looks up the state document and never
 * schedules, fetches providers, runs VHI, or invokes the evaluator.
 */
export async function GET(req: NextRequest) {
  let shopId: number;
  if (isExtensionBearerRequest(req)) {
    const extensionAuth = await auditStatusDeps.validateExtensionToken(req);
    if (!extensionAuth.authorized || !extensionAuth.user) {
      return NextResponse.json(
        buildAuthErrorBody(extensionAuth, { ok: false }),
        { status: getAuthErrorStatus(extensionAuth), headers: corsHeaders },
      );
    }
    shopId = Number(extensionAuth.user.shopId);
  } else {
    const session = await auditStatusDeps.getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }
    shopId = Number(session.shopId);
  }

  const provider = req.nextUrl.searchParams.get("provider")?.trim().toLowerCase() as AuditProvider | undefined;
  const workOrderId = req.nextUrl.searchParams.get("workOrderId")?.trim();
  if (!provider || !PROVIDERS.has(provider) || !workOrderId) {
    return NextResponse.json(
      { ok: false, error: "provider and workOrderId are required" },
      { status: 400, headers: corsHeaders },
    );
  }

  const unavailable = auditAutomationUnavailableReason(shopId);
  if (unavailable) {
    return NextResponse.json({ ok: true, status: "unavailable", reason: unavailable }, { headers: corsHeaders });
  }
  try {
    const entitlements = await auditStatusDeps.getFeatureEntitlements(shopId);
    if (!canAccessShopFeature({}, entitlements, "estimate_assist")) {
      return NextResponse.json(
        { ok: true, status: "unavailable", reason: "estimate_assist_not_entitled" },
        { headers: corsHeaders },
      );
    }
    const repository = await auditStatusDeps.getRepository();
    const state = await repository.findState(`${shopId}:${provider}:${workOrderId}`);
    // The deterministic repository key already scopes this read to the
    // authenticated shop/provider/RO tuple; never widen it to a bare RO id.
    const result = statusFromAuditState(state);
    const maintenanceAllowed = canAccessShopFeature({}, entitlements, "maintenance");
    if (!maintenanceAllowed && result.report) {
      // VHI findings are derived from a capability the shop no longer owns.
      // Preserve static/AI work but never leak stale VHI recommendations.
      const findings = result.report.findings.filter((finding) =>
        finding.source !== "vhi" && !(finding.sources?.length === 1 && finding.sources[0] === "vhi"),
      );
      const report = { ...result.report, findings, summary: summarizeFindings(findings) };
      return NextResponse.json(
        {
          ok: true,
          ...result,
          status: result.status === "complete" || result.status === "partial" ? "partial" : result.status,
          report,
          reason: result.status === "complete" || result.status === "partial"
            ? "maintenance_not_entitled"
            : result.reason,
        },
        { headers: corsHeaders },
      );
    }
    return NextResponse.json({ ok: true, ...result }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Estimate Audit Status] state read failed:", error?.message || error);
    return NextResponse.json(
      { ok: true, status: "unavailable", reason: "audit_state_unavailable" },
      { headers: corsHeaders },
    );
  }
}