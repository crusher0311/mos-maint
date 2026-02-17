import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";
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
    console.log("[Extension Features] Auth result:", { authorized: auth.authorized, userId: auth.user?._id, role: auth.user?.role });
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";
    console.log("[Extension Features] smsShopId:", smsShopId, "userShopIds:", userShopIds, "isPlatformAdmin:", isPlatformAdmin);

    let mosShopId: number | null = null;
    
    if (smsShopId) {
      const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin });
      console.log("[Extension Features] Shop lookup result:", shopResult ? { mosShopId: shopResult.mosShopId, provider: shopResult.provider } : null);
      if (shopResult) {
        mosShopId = shopResult.mosShopId;
      }
    }

    if (!mosShopId && userShopIds.length > 0) {
      mosShopId = userShopIds[0];
      console.log("[Extension Features] Fell back to first user shop:", mosShopId);
    }

    if (!mosShopId) {
      console.log("[Extension Features] No shop found, returning all false");
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
    console.log("[Extension Features] Shop", mosShopId, "entitlements:", JSON.stringify(entitlements.effectiveFeatures));

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
