import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus, buildAuthErrorBody, requireExtensionPrincipalScope } from "@/lib/extension-auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { loadVehicleHistory, matchLastPerformed } from "@/lib/last-performed";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * Task #743 — "Last performed" badge data for the extension Jobs flow.
 *
 * Given the current vehicle VIN and a batch of job/repair names (repeated
 * `name` params), returns for each name the most recent time that service
 * was actually performed on this vehicle (shop history or CARFAX), or null.
 *
 * Fact-only, non-blocking enrichment: the sidepanel renders search results
 * first and calls this to decorate them. An absent record yields null so no
 * false "never done" is ever shown.
 */
async function _GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const vin = (searchParams.get("vin") || "").trim();
    const smsShopId = searchParams.get("shopId");
    const providerParam = searchParams.get("provider") || undefined;
    const milesParam = searchParams.get("miles");
    const currentMiles = milesParam ? Number(milesParam) : null;
    const names = searchParams.getAll("name").map((n) => n.trim()).filter(Boolean).slice(0, 40);

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(buildAuthErrorBody(auth), { status: getAuthErrorStatus(auth), headers: corsHeaders });
    }

    if (!vin || names.length === 0) {
      return NextResponse.json({ results: [] }, { headers: corsHeaders });
    }

    const userShopIds = getUserShopIds(auth.user).map((id) => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    let mosShopId: number | null = null;
    if (smsShopId) {
      const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin, providerHint: providerParam });
      if (shopResult) {
        mosShopId = shopResult.mosShopId;
        const scopeFailure = requireExtensionPrincipalScope(auth, {
          shopId: shopResult.mosShopId,
          provider: providerParam || shopResult.provider,
        });
        if (scopeFailure) {
          return NextResponse.json(
            buildAuthErrorBody(scopeFailure),
            { status: getAuthErrorStatus(scopeFailure), headers: corsHeaders }
          );
        }
      }
    }
    if (!mosShopId && auth.user.shopId) {
      mosShopId = parseInt(auth.user.shopId);
    }

    if (!mosShopId) {
      return NextResponse.json({ results: [] }, { headers: corsHeaders });
    }

    // Same entitlement as job search.
    const denied = await checkShopFeatureGate(mosShopId, ["job_lookup"], {
      isPlatformAdmin,
      featureLabel: "Job Lookup",
      corsHeaders,
    });
    if (denied) return denied;

    const history = await loadVehicleHistory({
      shopId: mosShopId,
      vin,
      currentMiles: currentMiles && Number.isFinite(currentMiles) ? currentMiles : null,
    });

    const results = names.map((name) => ({
      name,
      lastPerformed: matchLastPerformed(history, name),
    }));

    return NextResponse.json({ results }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Extension Last-Performed] Error:", error);
    // Non-blocking enrichment: fail soft so the Jobs flow keeps working.
    return NextResponse.json({ results: [] }, { status: 200, headers: corsHeaders });
  }
}

export const GET = withExtensionErrorMarker(_GET as any);
