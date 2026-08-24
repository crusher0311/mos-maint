// Task #991 — Auto DVI: extension endpoint that composes a vehicle-specific
// inspection from the VHI (overdue + due-soon + OE inspect-only) merged with
// the shop's custom inspection items, with coverage-based dedup (hidden
// items carry a "covered by …" reason). Response shape:
//   { ok: true, vin, vehicle, score, mileage, items, hidden, generatedAt }
// Errors follow the extension convention: { error } (+ feature_disabled code
// from the shared guard).

import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { composeAutoDvi } from "@/lib/auto-dvi/service";

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

// Interactive budget: rebuildVhi runs fast-mode, AI fallback is capped at
// 8s — 30s covers a cold build without letting the panel hang forever.
const COMPOSE_TIMEOUT_MS = 30_000;

async function _POST(req: NextRequest) {
  try {
    let body: { shopId?: string | number; vin?: string; mileage?: number; provider?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
    }

    if (!body.shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!body.vin) {
      return NextResponse.json({ error: "vin is required" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: body.shopId,
      provider: body.provider || "tekmetric",
      requiredFeatures: ["auto_dvi"],
      featureLabel: "Auto DVI",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const result = await withUpstreamTimeout(
      composeAutoDvi({
        shopId: guard.mosShopId,
        vin: body.vin,
        mileage: typeof body.mileage === "number" ? body.mileage : null,
      }),
      COMPOSE_TIMEOUT_MS,
      "auto-dvi-compose",
      { ok: false as const, error: "Inspection build timed out — please try again" },
    );

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502, headers: corsHeaders });
    }
    return NextResponse.json(result, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[AutoDVI generate] Error:", err?.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
}

export const POST = withExtensionErrorMarker(_POST as any);
