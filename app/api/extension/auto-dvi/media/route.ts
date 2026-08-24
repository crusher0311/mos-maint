// Task #991 — Auto DVI media upload (extension): base64 JSON photo attached
// to an inspection item (extension messaging cannot pass File/Blob — same
// pattern as the vin-plate-ocr extension route). Videos are dashboard-only:
// base64 through chrome messaging is not viable at video sizes.

import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { storeInspectionMedia, readInspectionResults } from "@/lib/data/repositories/auto-dvi";

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

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_PER_ITEM = 6;

async function _POST(req: NextRequest) {
  try {
    let body: {
      shopId?: string | number;
      provider?: string;
      vin?: string;
      itemId?: string;
      itemName?: string;
      mimeType?: string;
      imageBase64?: string;
      filename?: string;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
    }
    if (!body.shopId) return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    const vin = (body.vin || "").toUpperCase().trim();
    const itemId = (body.itemId || "").trim();
    if (!vin || !itemId || !body.imageBase64) {
      return NextResponse.json({ error: "vin, itemId, and imageBase64 are required" }, { status: 400, headers: corsHeaders });
    }
    const contentType = body.mimeType || "image/jpeg";
    if (!PHOTO_TYPES.has(contentType)) {
      return NextResponse.json({ error: "Unsupported type — photos only (jpeg/png/webp/gif)" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: body.shopId,
      provider: body.provider || "tekmetric",
      requiredFeatures: ["auto_dvi"],
      featureLabel: "Auto DVI",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const b64 = body.imageBase64.replace(/^data:[^;]+;base64,/, "");
    // Approximate decoded size before allocating the buffer.
    if ((b64.length * 3) / 4 > MAX_PHOTO_BYTES) {
      return NextResponse.json({ error: "Photo too large (max 8MB)" }, { status: 400, headers: corsHeaders });
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(b64, "base64");
    } catch {
      return NextResponse.json({ error: "Invalid base64 image data" }, { status: 400, headers: corsHeaders });
    }

    const existing = await readInspectionResults(guard.mosShopId, vin);
    const item = existing?.items.find((it) => it.itemId === itemId);
    if ((item?.media?.length || 0) >= MAX_MEDIA_PER_ITEM) {
      return NextResponse.json({ error: `Max ${MAX_MEDIA_PER_ITEM} attachments per item` }, { status: 400, headers: corsHeaders });
    }

    const ref = await storeInspectionMedia({
      shopId: guard.mosShopId,
      vinUpper: vin,
      itemId,
      itemName: body.itemName || itemId,
      kind: "photo",
      contentType,
      filename: body.filename || null,
      buffer,
    });
    return NextResponse.json({ ok: true, media: ref }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[AutoDVI media] Error:", err?.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
}

export const POST = withExtensionErrorMarker(_POST as any);
