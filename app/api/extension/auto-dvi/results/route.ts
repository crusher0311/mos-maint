// Task #991 — Auto DVI results (extension): load/save per-item technician
// findings (rating / notes / recommendation) from the side panel. Same
// storage as the dashboard results route. GET via POST-with-action to keep
// one guarded body-shape (extension messaging is JSON-only).

import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { AUTO_DVI_REQUIRED_FEATURES } from "@/lib/shop-feature-access";
import {
  readInspectionResults,
  saveInspectionResults,
  type InspectionRating,
} from "@/lib/data/repositories/auto-dvi";

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

const MAX_ITEMS = 200;
const MAX_TEXT = 1000;
const VALID_RATINGS = new Set(["green", "yellow", "red"]);

async function _POST(req: NextRequest) {
  try {
    let body: {
      shopId?: string | number;
      provider?: string;
      vin?: string;
      action?: "load" | "save";
      items?: Array<{
        itemId?: string;
        name?: string;
        rating?: string | null;
        notes?: string | null;
        recommendation?: string | null;
      }>;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
    }
    if (!body.shopId) return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    const vin = (body.vin || "").toUpperCase().trim();
    if (!vin) return NextResponse.json({ error: "vin is required" }, { status: 400, headers: corsHeaders });

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: body.shopId,
      provider: body.provider || "tekmetric",
      requiredFeatures: AUTO_DVI_REQUIRED_FEATURES,
      featureLabel: "Auto DVI",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    if (body.action === "load") {
      const doc = await readInspectionResults(guard.mosShopId, vin);
      return NextResponse.json({ ok: true, results: doc }, { headers: corsHeaders });
    }

    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0 || rawItems.length > MAX_ITEMS) {
      return NextResponse.json({ error: `items must contain 1-${MAX_ITEMS} entries` }, { status: 400, headers: corsHeaders });
    }
    const items = [];
    for (const it of rawItems) {
      if (!it?.itemId || typeof it.itemId !== "string") {
        return NextResponse.json({ error: "each item needs an itemId" }, { status: 400, headers: corsHeaders });
      }
      if (it.rating != null && !VALID_RATINGS.has(it.rating)) {
        return NextResponse.json({ error: `invalid rating "${it.rating}"` }, { status: 400, headers: corsHeaders });
      }
      items.push({
        itemId: it.itemId.slice(0, 200),
        name: String(it.name || "").slice(0, 200),
        rating: it.rating === undefined ? undefined : ((it.rating as InspectionRating) ?? null),
        notes: it.notes === undefined ? undefined : it.notes ? String(it.notes).slice(0, MAX_TEXT) : null,
        recommendation:
          it.recommendation === undefined
            ? undefined
            : it.recommendation
              ? String(it.recommendation).slice(0, MAX_TEXT)
              : null,
      });
    }
    const doc = await saveInspectionResults({
      shopId: guard.mosShopId,
      vinUpper: vin,
      items,
      updatedBy: guard.user?.email || null,
    });
    return NextResponse.json({ ok: true, results: doc }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[AutoDVI results] Error:", err?.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
}

export const POST = withExtensionErrorMarker(_POST as any);
