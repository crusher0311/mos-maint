import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";

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
    const provider = searchParams.get("provider") || "tekmetric";

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const db = await getDb();
    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    let mosShopId: number | null = null;
    
    if (smsShopId) {
      if (provider === "tekmetric") {
        const query: any = { "tekmetric.shopId": parseInt(smsShopId) };
        if (!isPlatformAdmin) {
          query.shopId = { $in: userShopIds };
        }
        const shop = await db.collection("shops").findOne(query);
        if (shop) {
          mosShopId = shop.shopId;
        }
      } else if (provider === "protractor") {
        const query: any = { "protractor.connectionId": smsShopId };
        if (!isPlatformAdmin) {
          query.shopId = { $in: userShopIds };
        }
        const shop = await db.collection("shops").findOne(query);
        if (shop) {
          mosShopId = shop.shopId;
        }
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
          part_xref: false
        }
      }, { headers: corsHeaders });
    }

    const features = await getFeatureEntitlements(mosShopId);

    return NextResponse.json({ 
      features,
      shopId: mosShopId
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Features] Error:", error);
    return NextResponse.json(
      { error: "Failed to load features" },
      { status: 500, headers: corsHeaders }
    );
  }
}
