// Task #809 — real part costs on Tekmetric pushes.
//
// The actual Tekmetric job write happens extension-side (background
// CREATE_TEKMETRIC_JOB using the page session), so the extension can't read
// the shop's configurable `partCostEstimateRatio` (shops doc) itself. This
// route is the server half of that push: the extension sends the part lines
// it's about to write, and we resolve each one with the same provider-
// agnostic resolver + [PartCost] logging the Protractor write paths use
// (lib/integrations/protractor/part-cost.ts):
//   - a part with a known-real `unitCost` writes it through unchanged
//   - anything else is estimated as retail × the shop's cost ratio
// The extension treats this as best-effort — on any failure it falls back to
// a local estimate so a cost lookup never blocks adding a job to an RO.
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import {
  getShopPartCostRatio,
  resolvePartLineCost,
  logPartCostResolution,
} from "@/lib/integrations/protractor/part-cost";

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

type IncomingPart = {
  name?: string;
  quantity?: number;
  /** Retail per-unit price in dollars. */
  retail?: number;
  /** Real per-unit cost in dollars, when the source knows it. */
  unitCost?: number;
};

async function _POST(req: NextRequest) {
  try {
    let body: {
      shopId?: string | number;
      jobTitle?: string;
      parts?: IncomingPart[];
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
    }

    const { shopId, jobTitle, parts } = body;
    if (!shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!Array.isArray(parts)) {
      return NextResponse.json({ error: "parts array is required" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: shopId,
      provider: "tekmetric",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const ratio = await getShopPartCostRatio(guard.mosShopId);

    const resolved = parts.map((part) => {
      const qty =
        typeof part?.quantity === "number" && Number.isFinite(part.quantity) && part.quantity > 0
          ? part.quantity
          : 1;
      const retail =
        typeof part?.retail === "number" && Number.isFinite(part.retail) && part.retail > 0
          ? part.retail
          : 0;
      const unitCost =
        typeof part?.unitCost === "number" && Number.isFinite(part.unitCost) && part.unitCost > 0
          ? part.unitCost
          : 0;

      const r = resolvePartLineCost(
        {
          quantity: qty,
          unitPrice: retail,
          extendedPrice: qty * retail,
          ...(unitCost > 0 ? { cost: unitCost } : {}),
        },
        ratio,
      );
      logPartCostResolution({
        tag: "[Tekmetric]",
        shopId: guard.mosShopId,
        jobTitle: jobTitle || "Job",
        description: part?.name || "Part",
        resolved: r,
        ratio,
        unitPrice: retail,
      });
      return {
        unitCost: Math.round(r.unitCost * 100) / 100,
        totalCost: Math.round(r.totalCost * 100) / 100,
        source: r.source,
      };
    });

    return NextResponse.json({ ok: true, ratio, parts: resolved }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[Extension Resolve Part Costs] Error:", err?.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
