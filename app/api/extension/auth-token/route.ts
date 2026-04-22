// gate-exempt: pre-feature plumbing — issues/refreshes the extension auth
// token itself, so it must work even for shops with zero feature entitlements.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus } from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: getAuthErrorStatus(auth), headers: corsHeaders }
      );
    }

    const body = await request.json();
    const { provider, smsShopId, token } = body;

    if (!provider || !smsShopId || !token) {
      return NextResponse.json(
        { error: "provider, smsShopId, and token are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (provider !== "tekmetric") {
      return NextResponse.json(
        { error: "Only tekmetric provider is supported for auth token storage" },
        { status: 400, headers: corsHeaders }
      );
    }

    const userShopIds = getUserShopIds(auth.user).map((id) => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    const shopResult = await findShopBySmsId(String(smsShopId), {
      userShopIds,
      isPlatformAdmin,
      providerHint: provider,
    });

    if (!shopResult) {
      return NextResponse.json(
        { error: "Shop not found or access denied" },
        { status: 403, headers: corsHeaders }
      );
    }

    const db = await getDb();
    const internalShopId = shopResult.mosShopId;

    const result = await db.collection("shops").updateOne(
      { shopId: { $in: [String(internalShopId), Number(internalShopId)] } },
      {
        $set: {
          "tekmetric.xAuthToken": token,
          "tekmetric.xAuthTokenUpdatedAt": new Date(),
          "tekmetric.xAuthTokenSource": "extension",
          "tekmetric.xAuthTokenUser": auth.user.email || auth.user.username || null,
        },
      }
    );

    if (result.matchedCount === 0) {
      console.warn(`[Extension Auth Token] Shop doc not found for shopId ${internalShopId}`);
      return NextResponse.json(
        { error: "Shop document not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    console.log(
      `[Extension Auth Token] Stored x-auth-token for shop ${internalShopId} (tekmetric ${smsShopId}) from ${auth.user.email || auth.user.username || "unknown"}`
    );

    return NextResponse.json(
      { ok: true, mosShopId: internalShopId },
      { headers: corsHeaders }
    );
  } catch (err: any) {
    console.error("[Extension Auth Token] Error:", err.message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}
