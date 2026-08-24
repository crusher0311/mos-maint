// Task #991 — Auto DVI voice findings (dashboard session): accepts a
// dictation recording (any language) plus the current checklist, returns
// translated/structured findings matched onto checklist items. New
// components the tech mentions come back as ad-hoc `voice:` items.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { extractVoiceFindings } from "@/lib/auto-dvi/voice";
import { parseChecklistParam } from "@/lib/auto-dvi/voice-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await checkShopFeatureGate(Number(session.shopId), ["auto_dvi"], {
    isPlatformAdmin: session.role === "platform_admin",
    featureLabel: "Auto DVI",
  });
  if (denied) return denied;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  const vin = String(form.get("vin") || "").toUpperCase().trim();
  if (!vin) return NextResponse.json({ error: "vin is required" }, { status: 400 });
  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "audio file is required" }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "Audio too large (max 25MB)" }, { status: 400 });
  }
  const checklist = parseChecklistParam(form.get("items"));

  const buffer = Buffer.from(await audio.arrayBuffer());
  const result = await extractVoiceFindings(
    Number(session.shopId),
    buffer,
    audio.type || "audio/webm",
    checklist,
  );
  if (!result.ok) {
    // Transcript (when we got one) still comes back so the dictation isn't lost.
    return NextResponse.json(
      { ok: false, error: result.error, transcript: result.transcript ?? null },
      { status: 502 },
    );
  }
  return NextResponse.json({
    ok: true,
    transcript: result.transcript,
    language: result.language ?? null,
    findings: result.findings ?? [],
  });
}
