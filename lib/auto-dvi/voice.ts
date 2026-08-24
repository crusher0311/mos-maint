// Task #991 — Auto DVI voice findings (server side): Deepgram multilingual
// transcription + one OpenAI structuring/translation pass. Failures are
// explicit ({ok:false,error}) — callers surface them; nothing here blocks
// the manual entry path.

import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import {
  buildVoiceStructuringPrompt,
  matchVoiceFindings,
  type VoiceChecklistItem,
  type VoiceFinding,
} from "./voice-parse";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const STRUCTURE_TIMEOUT_MS = 20_000;

export interface VoiceTranscribeResult {
  ok: boolean;
  transcript?: string;
  detectedLanguage?: string | null;
  error?: string;
}

export async function transcribeInspectionAudio(
  audio: Buffer,
  mimeType: string,
): Promise<VoiceTranscribeResult> {
  if (!audio?.length) return { ok: false, error: "Empty audio" };
  if (audio.length > MAX_AUDIO_BYTES) return { ok: false, error: "Audio too large (max 25MB)" };
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return { ok: false, error: "Transcription not configured (missing Deepgram key)" };
  try {
    // Deepgram pre-recorded REST API (the installed v5 SDK dropped the old
    // createClient/prerecorded surface; the REST contract is stable).
    const params = new URLSearchParams({
      model: "nova-2",
      detect_language: "true",
      smart_format: "true",
      punctuate: "true",
    });
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": mimeType || "audio/webm",
      },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      return { ok: false, error: `Transcription failed (${res.status}): ${text}` };
    }
    const result: any = await res.json();
    const channel = result?.results?.channels?.[0];
    const alt = channel?.alternatives?.[0];
    const transcript = (alt?.transcript || "").trim();
    if (!transcript) return { ok: false, error: "No speech detected in the recording" };
    return {
      ok: true,
      transcript,
      detectedLanguage: channel?.detected_language || null,
    };
  } catch (err: any) {
    return { ok: false, error: `Transcription failed: ${err?.message || String(err)}` };
  }
}

export interface VoiceFindingsResult {
  ok: boolean;
  transcript?: string;
  language?: string | null;
  findings?: VoiceFinding[];
  error?: string;
}

/**
 * Full pipeline: transcribe → translate/structure → match to checklist.
 * The structuring call is bounded; on AI failure the transcript is still
 * returned so the tech's dictation is never lost.
 */
export async function extractVoiceFindings(
  shopId: number,
  audio: Buffer,
  mimeType: string,
  checklist: VoiceChecklistItem[],
): Promise<VoiceFindingsResult> {
  const t = await transcribeInspectionAudio(audio, mimeType);
  if (!t.ok || !t.transcript) return { ok: false, error: t.error || "Transcription failed" };

  try {
    const openai = getOpenAI();
    const started = Date.now();
    const completion = await openai.chat.completions.create(
      {
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [
          { role: "system", content: buildVoiceStructuringPrompt(checklist.map((c) => c.name)) },
          { role: "user", content: t.transcript },
        ],
      },
      { signal: AbortSignal.timeout(STRUCTURE_TIMEOUT_MS) },
    );
    trackOpenAiCall(shopId, "/api/auto-dvi/voice", completion as any, Date.now() - started, 200);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
    } catch {
      parsed = null;
    }
    const { language, findings } = matchVoiceFindings(parsed, checklist);
    return {
      ok: true,
      transcript: t.transcript,
      language: language || t.detectedLanguage || null,
      findings,
    };
  } catch (err: any) {
    // AI failure: still hand back the transcript so nothing is lost.
    return {
      ok: false,
      transcript: t.transcript,
      language: t.detectedLanguage || null,
      error: `Could not structure the dictation: ${err?.message || String(err)}`,
    };
  }
}
