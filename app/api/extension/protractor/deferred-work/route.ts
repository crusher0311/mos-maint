import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { fetchDeferredWorkWithCache } from "@/lib/integrations/protractor";

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
    const serviceItemId = req.nextUrl.searchParams.get("serviceItemId");

    if (!shopIdParam) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!vin || !serviceItemId) {
      return NextResponse.json({ error: "vin and serviceItemId are required" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: shopIdParam,
      provider: req.nextUrl.searchParams.get("provider") || "protractor",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const result = await fetchDeferredWorkWithCache(guard.mosShopId, vin, serviceItemId);

    if (!result.ok || !result.deferredWork) {
      return NextResponse.json({ error: result.error || "Failed to fetch deferred work" }, { status: 500, headers: corsHeaders });
    }

    const items = result.deferredWork.map((dw: any) => {
      let lines: any[] = [];
      if (dw.ServicePackageLines) {
        const linesRaw = dw.ServicePackageLines;
        if (Array.isArray(linesRaw)) {
          lines = linesRaw;
        } else if (linesRaw?.ItemCollection) {
          lines = linesRaw.ItemCollection;
        }
      }
      return {
        id: dw.ID,
        title: dw.ServicePackageHeader?.Title || dw.Title || "",
        description: dw.ServicePackageHeader?.Description || dw.Description || "",
        code: dw.Code || "",
        originalWorkOrderNumber: dw.OriginalWorkOrderNumber || null,
        originalWorkOrderId: dw.OriginalWorkOrderID || null,
        date: dw.DeferredDate || dw.CreatedDate || null,
        chapter: dw.Chapter || "",
        lines: lines.map((l: any) => ({
          description: l.Description || l.description || "",
          lineType: l.Type || l.LineType || l.lineType || "Labor",
          quantity: l.Quantity ?? l.quantity ?? 1,
          unitPrice: l.Price ?? l.UnitPrice ?? l.unitPrice ?? 0,
          partNumber: l.PartNumber || l.partNumber || "",
          manufacturer: l.Manufacturer || l.manufacturer || "",
        })),
      };
    });

    return NextResponse.json({ ok: true, items }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[Extension Protractor Deferred Work] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
