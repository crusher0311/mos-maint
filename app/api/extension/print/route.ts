/**
 * Enqueue endpoint (task #542, Milestone 2).
 *
 *   POST /api/extension/print  -> { success, jobId }
 *
 * Accepts a print request from the web app / extension, renders (or
 * accepts a pre-rendered) sticker/keytag image, applies the shop's stored
 * printer-config defaults, and writes a single PENDING job scoped to the
 * shop. The cloud never opens a printer socket — a shop agent later polls
 * `/api/print-agent/jobs` and prints it locally.
 *
 * Security follows the extension model: token validation + shop scoping +
 * feature gating via `guardExtensionShopRequest`, and the standard
 * error-marker wrapper.
 *
 * Image source (reuses existing generation, no duplicated rendering):
 *   - `imageBase64` (PNG or JPEG, bare or data-URI) — produced by the
 *     existing `/api/extension/sticker` or `/api/extension/keytag`
 *     endpoints — is enqueued directly, OR
 *   - `type: "keytag"` + `keytag` fields — rendered server-side via the
 *     same `renderKeytag*` canvas functions the keytag route uses.
 */

import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { findShopByExactShopId } from "@/lib/data/repositories/shops";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import {
  enqueuePrintJob,
  getPrinterConfig,
  resolveJobOptions,
} from "@/lib/print-queue/repository";
import { toJpegBase64, renderKeytagBuffer } from "@/lib/print-queue/render";
import type { ZinkPrintOptions } from "@/lib/print-queue/types";

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

function normalizeOptions(raw: any): ZinkPrintOptions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const opts: ZinkPrintOptions = {};
  if (raw.width != null) opts.width = Number(raw.width);
  if (raw.cut === 0 || raw.cut === 1) opts.cut = raw.cut;
  if (raw.speed === 0 || raw.speed === 1) opts.speed = raw.speed;
  return Object.keys(opts).length > 0 ? opts : undefined;
}

async function _POST(req: NextRequest) {
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
    provider: body?.provider ?? null,
    requiredFeatures: ["oil_sticker"],
    featureLabel: "ZINK Print",
    corsHeaders,
  });
  if (!guard.ok) return guard.response;

  const shopId = guard.mosShopId;
  const type: "sticker" | "keytag" | "raw" =
    body?.type === "keytag" ? "keytag" : body?.type === "sticker" ? "sticker" : "raw";

  // Resolve the image payload: pre-rendered image preferred, else render a
  // keytag server-side from the shop's keytag config.
  let imageBase64: string;
  try {
    if (typeof body?.imageBase64 === "string" && body.imageBase64.trim() !== "") {
      imageBase64 = await toJpegBase64(body.imageBase64);
    } else if (type === "keytag" && body?.keytag) {
      const k = body.keytag;
      if (!k.customerName || !k.vehicleInfo || !k.roNumber) {
        return NextResponse.json(
          { error: "keytag requires customerName, vehicleInfo, roNumber" },
          { status: 400, headers: corsHeaders },
        );
      }
      const shop = await findShopByExactShopId<any>(shopId, { keytagConfig: 1 });
      const png = await renderKeytagBuffer(shop?.keytagConfig, {
        customerName: k.customerName,
        vehicleInfo: k.vehicleInfo,
        vin: k.vin,
        roNumber: k.roNumber,
        mileage: k.mileage ?? "",
      });
      imageBase64 = await toJpegBase64(png);
    } else {
      return NextResponse.json(
        {
          error:
            "Provide imageBase64 (from /api/extension/sticker or /keytag) or type='keytag' with keytag data",
        },
        { status: 400, headers: corsHeaders },
      );
    }
  } catch (err: any) {
    console.error("[Print Enqueue] image preparation failed:", err?.message);
    return NextResponse.json(
      { error: "Failed to prepare print image", message: err?.message },
      { status: 500, headers: corsHeaders },
    );
  }

  const config = await getPrinterConfig(shopId);
  const options = resolveJobOptions(config, normalizeOptions(body?.options));

  const printerId =
    typeof body?.printerId === "string" && body.printerId.trim() !== ""
      ? body.printerId.trim()
      : null;

  // Per-job printer override (rare); falls back to the agent's own config.
  const printer =
    body?.printer && typeof body.printer.address === "string"
      ? {
          address: body.printer.address,
          ...(body.printer.port != null ? { port: Number(body.printer.port) } : {}),
        }
      : config?.address
        ? { address: config.address, port: config.port }
        : undefined;

  const jobId = await enqueuePrintJob({
    shopId,
    imageBase64,
    printerId,
    options,
    printer,
    kind: type,
    meta: {
      requestedBy: guard.user?.email ?? null,
      roNumber: body?.keytag?.roNumber ?? body?.meta?.roNumber ?? null,
      vin: body?.keytag?.vin ?? body?.meta?.vin ?? null,
    },
  });

  return NextResponse.json(
    { success: true, jobId, status: "pending" },
    { status: 201, headers: corsHeaders },
  );
}

export const POST = withExtensionErrorMarker(_POST as any);
