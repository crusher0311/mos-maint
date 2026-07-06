import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { listTekmetricDeferredWorkByVin } from "@/lib/data/repositories/tekmetric-deferred-work";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _GET(req: NextRequest) {
  try {
    const shopIdParam = req.nextUrl.searchParams.get("shopId");
    const vin = req.nextUrl.searchParams.get("vin");

    if (!shopIdParam) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!vin) {
      return NextResponse.json({ error: "vin is required" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: shopIdParam,
      provider: req.nextUrl.searchParams.get("provider") || "tekmetric",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const items = await listTekmetricDeferredWorkByVin(guard.mosShopId, vin);

    // An empty history is a valid, clean state — not an error.
    return NextResponse.json({ ok: true, items }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[Extension Tekmetric Deferred Work] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
