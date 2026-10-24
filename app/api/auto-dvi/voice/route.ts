// Task #991 — Auto DVI voice findings (dashboard session): accepts a
// dictation recording (any language) plus the current checklist, returns
// translated/structured findings matched onto checklist items. New
// components the tech mentions come back as ad-hoc `voice:` items.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { extractVoiceFindings } from "@/lib/auto-dvi/voice";
import { parseChecklistParam } from "@/lib/auto-dvi/voice-parse";
import { visitAssistanceContext, suggestionId } from "@/lib/auto-dvi/staff/assistance-context";
import { dispatchFailure } from "@/lib/shop-dispatch/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  let context: Awaited<ReturnType<typeof visitAssistanceContext>> | undefined;
  if (form.has("visitId")) {
    try { context = await visitAssistanceContext(form.get("visitId"), form.get("revision")); }
    catch (cause) { return dispatchFailure(cause); }
  } else {
    const denied = await checkShopFeatureGate(Number(session.shopId), ["maintenance", "auto_dvi"], {
      isPlatformAdmin: session.role === "platform_admin" && !session.isImpersonation, featureLabel: "Auto DVI",
    });
    if (denied) return denied;
  }
  const vin = String(form.get("vin") || "").toUpperCase().trim();
  if (!context && !vin) return NextResponse.json({ error: "vin is required" }, { status: 400 });
  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "audio file is required" }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "Audio too large (max 25MB)" }, { status: 400 });
  }
  const checklist = context?.targets ?? parseChecklistParam(form.get("items"));

  const buffer = Buffer.from(await audio.arrayBuffer());
  const result = await extractVoiceFindings(
    context?.shopId ?? Number(session.shopId),
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
  if (context) {
    try { await context.revalidate(); } catch (cause) { return dispatchFailure(cause); }
  }
  return NextResponse.json({
    ok: true,
    ...(context ? {visitId: context.visitId, revision: context.revision, targets: context.targets} : {}),
    transcript: result.transcript,
    language: result.language ?? null,
    findings: context ? (result.findings ?? []).map(f => ({
      ...f,
      ...(!context.targets.some(t => t.itemId === f.itemId) ? {newCheck: {
        id: suggestionId("voice", f.itemId), name: f.name.slice(0, 160), source: "voice",
        reference: f.itemId.slice(0, 120),
      }} : {}),
    })) : result.findings ?? [],
  });
}
