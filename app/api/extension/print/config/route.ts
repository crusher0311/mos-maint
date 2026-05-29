/**
 * Per-shop printer config management (task #542, Milestone 2).
 *
 *   GET /api/extension/print/config?smsShopId=...   -> { config }
 *   PUT /api/extension/print/config                 body -> { config }
 *
 * Backend read/write for a shop's printer config (address + default
 * cut/speed/width). The admin UI lands in Milestone 3; this exposes the
 * storage so config can be set today. Security follows the extension model
 * (token + shop scoping + feature gate via `guardExtensionShopRequest`),
 * with the standard error-marker wrapper.
 */

import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import {
  getPrinterConfig,
  upsertPrinterConfig,
} from "@/lib/print-queue/repository";
import { PRINTER_DEFAULTS } from "@/lib/print-queue/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _GET(req: NextRequest) {
  const smsShopId = req.nextUrl.searchParams.get("smsShopId");

  const guard = await guardExtensionShopRequest(req, {
    smsShopId,
    requiredFeatures: ["oil_sticker"],
    featureLabel: "ZINK Print",
    corsHeaders,
  });
  if (!guard.ok) return guard.response;

  const config = await getPrinterConfig(guard.mosShopId);
  return NextResponse.json(
    {
      config: config ?? null,
      defaults: PRINTER_DEFAULTS,
    },
    { headers: corsHeaders },
  );
}

async function _PUT(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: corsHeaders },
    );
  }

  const smsShopId = body?.smsShopId ?? body?.shopId;

  const guard = await guardExtensionShopRequest(req, {
    smsShopId,
    requiredFeatures: ["oil_sticker"],
    featureLabel: "ZINK Print",
    corsHeaders,
  });
  if (!guard.ok) return guard.response;

  if (body?.address != null && typeof body.address !== "string") {
    return NextResponse.json(
      { error: "address must be a string" },
      { status: 400, headers: corsHeaders },
    );
  }
  if (body?.cut != null && body.cut !== 0 && body.cut !== 1) {
    return NextResponse.json(
      { error: "cut must be 0 or 1" },
      { status: 400, headers: corsHeaders },
    );
  }
  if (body?.speed != null && body.speed !== 0 && body.speed !== 1) {
    return NextResponse.json(
      { error: "speed must be 0 or 1" },
      { status: 400, headers: corsHeaders },
    );
  }

  const config = await upsertPrinterConfig(guard.mosShopId, {
    address: body?.address,
    port: body?.port != null ? Number(body.port) : undefined,
    defaultCut: body?.cut,
    defaultSpeed: body?.speed,
    defaultWidth: body?.width != null ? Number(body.width) : undefined,
  });

  return NextResponse.json({ success: true, config }, { headers: corsHeaders });
}

export const GET = withExtensionErrorMarker(_GET as any);
export const PUT = withExtensionErrorMarker(_PUT as any);
