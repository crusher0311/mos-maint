// Task #991 — Auto DVI voice findings (extension side panel): JSON body
// with base64 audio (matching the extension media route pattern), guarded
// by the standard extension shop guard + auto_dvi feature gate.

import { NextRequest, NextResponse } from "next/server";
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { extractVoiceFindings } from "@/lib/auto-dvi/voice";
import { parseChecklistParam } from "@/lib/auto-dvi/voice-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const POST = withExtensionErrorMarker(async (req: NextRequest) => {
  let body: {
    shopId?: string;
    provider?: string;
    vin?: string;
    audioBase64?: string;
    mimeType?: string;
    items?: Array<{ itemId?: string; name?: string; serviceKey?: string | null }>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
  }

  const guard = await guardExtensionShopRequest(req, {
    smsShopId: body.shopId,
    provider: body.provider,
    requiredFeatures: ["auto_dvi"],
    corsHeaders,
  });
  if (!guard.ok) return guard.response;

  const vin = String(body.vin || "").toUpperCase().trim();
  if (!vin) return NextResponse.json({ success: false, error: "vin is required" }, { status: 400, headers: corsHeaders });
  const b64 = String(body.audioBase64 || "");
  if (!b64) return NextResponse.json({ success: false, error: "audioBase64 is required" }, { status: 400, headers: corsHeaders });
  let audio: Buffer;
  try {
    audio = Buffer.from(b64, "base64");
  } catch {
    return NextResponse.json({ success: false, error: "Invalid base64 audio" }, { status: 400, headers: corsHeaders });
  }
  if (!audio.length || audio.length > MAX_AUDIO_BYTES) {
    return NextResponse.json({ success: false, error: "Audio empty or too large (max 25MB)" }, { status: 400, headers: corsHeaders });
  }

  const result = await extractVoiceFindings(
    guard.mosShopId,
    audio,
    body.mimeType || "audio/webm",
    parseChecklistParam(body.items),
  );
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, transcript: result.transcript ?? null },
      { status: 502, headers: corsHeaders },
    );
  }
  return NextResponse.json(
    { ok: true, transcript: result.transcript, language: result.language ?? null, findings: result.findings ?? [] },
    { headers: corsHeaders },
  );
});
