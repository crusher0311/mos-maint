import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus } from "@/lib/extension-auth";
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

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const smsShopId = searchParams.get("shopId");

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: getAuthErrorStatus(auth), headers: corsHeaders });
    }

    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    let mosShopId: number | null = null;
    
    if (smsShopId) {
      const provider = searchParams.get("provider") || undefined;
      const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin, providerHint: provider });
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
          concern_assistant: false
        }
      }, { headers: corsHeaders });
    }

    const entitlements = await getFeatureEntitlements(mosShopId);

    return NextResponse.json({ 
      features: entitlements.effectiveFeatures,
      shopId: mosShopId,
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
