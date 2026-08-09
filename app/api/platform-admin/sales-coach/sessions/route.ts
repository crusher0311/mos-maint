// Sales-coach practice sessions API (task #987).
// POST: multipart upload of a recorded pitch → transcribe → AI coaching →
// persist the full session (audio, transcript, feedback, score) as corpus.
// GET: list sessions (metadata only — audio streams via /sessions/[id]/audio).
// Platform-admin only; the route enforces its own authz.
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db/drizzle";
import { salesCoachSessions } from "@/lib/db/schema/sales-coach";
import { transcribeAudio, coachPitch } from "@/lib/sales-coach/coach";
import type { SalesCoachScenarioContext } from "@/lib/db/schema/sales-coach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Recorded pitches are short (a few minutes of speech); 25 MB matches the
// OpenAI audio-upload ceiling and is far more than a webm/opus pitch needs.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

async function requirePlatformAdminApi() {
  const session = await getSession();
  if (!session) return { denied: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }), session: null };
  if (!session.isPlatformAdmin) return { denied: NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 }), session: null };
  return { denied: null, session };
}

export async function GET(req: NextRequest) {
  const { denied } = await requirePlatformAdminApi();
  if (denied) return denied;
  try {
    const db = getDb();
    const scenarioId = req.nextUrl.searchParams.get("scenarioId");
    const limit = Math.min(200, Number(req.nextUrl.searchParams.get("limit")) || 100);
    const rows: any[] = await db.execute(sql`
      SELECT s.id, s.scenario_id, s.user_email, s.audio_mime, s.audio_bytes,
             s.duration_sec, s.transcript, s.transcription_provider,
             s.feedback, s.score, s.created_at,
             sc.scenario_type, sc.work_order_number, sc.context
      FROM sales_coach_sessions s
      JOIN sales_coach_scenarios sc ON sc.id = s.scenario_id
      WHERE ${scenarioId ? sql`s.scenario_id = ${scenarioId}` : sql`true`}
      ORDER BY s.created_at DESC
      LIMIT ${limit}
    `);
    return NextResponse.json({
      ok: true,
      sessions: rows.map((r) => ({
        id: r.id,
        scenarioId: r.scenario_id,
        userEmail: r.user_email,
        audioMime: r.audio_mime,
        audioBytes: r.audio_bytes,
        durationSec: r.duration_sec,
        transcript: r.transcript,
        transcriptionProvider: r.transcription_provider,
        feedback: r.feedback,
        score: r.score,
        createdAt: r.created_at,
        scenarioType: r.scenario_type,
        workOrderNumber: r.work_order_number,
        scenarioContext: r.context,
      })),
    });
  } catch (err: any) {
    console.error("[SalesCoach] sessions GET failed:", err?.message || err);
    return NextResponse.json({ ok: false, error: err?.message || "failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { denied, session } = await requirePlatformAdminApi();
  if (denied) return denied;
  try {
    const form = await req.formData();
    const scenarioId = String(form.get("scenarioId") || "");
    const audioFile = form.get("audio");
    const durationSec = Number(form.get("durationSec")) || null;
    if (!scenarioId || !(audioFile instanceof File)) {
      return NextResponse.json({ ok: false, error: "scenarioId and audio file are required" }, { status: 400 });
    }
    if (audioFile.size === 0 || audioFile.size > MAX_AUDIO_BYTES) {
      return NextResponse.json({ ok: false, error: `Audio must be 1 byte – ${MAX_AUDIO_BYTES} bytes` }, { status: 400 });
    }

    const db = getDb();
    const scenarioRows: any[] = await db.execute(sql`
      SELECT id, context FROM sales_coach_scenarios WHERE id = ${scenarioId}
    `);
    if (scenarioRows.length === 0) {
      return NextResponse.json({ ok: false, error: "Scenario not found" }, { status: 404 });
    }
    const context = scenarioRows[0].context as SalesCoachScenarioContext;

    const mime = audioFile.type || "audio/webm";
    const audio = Buffer.from(await audioFile.arrayBuffer());

    const { transcript, provider } = await transcribeAudio(audio, mime);
    if (!transcript) {
      return NextResponse.json(
        { ok: false, error: "Could not transcribe any speech from the recording. Try again closer to the microphone." },
        { status: 422 },
      );
    }

    const feedback = await coachPitch(context, transcript);

    const inserted = await db.insert(salesCoachSessions).values({
      scenarioId,
      userEmail: session!.email,
      audio,
      audioMime: mime,
      audioBytes: audio.length,
      durationSec,
      transcript,
      transcriptionProvider: provider,
      feedback,
      score: feedback.score,
    }).returning({ id: salesCoachSessions.id, createdAt: salesCoachSessions.createdAt });

    return NextResponse.json({
      ok: true,
      session: {
        id: inserted[0].id,
        scenarioId,
        transcript,
        transcriptionProvider: provider,
        feedback,
        score: feedback.score,
        durationSec,
        createdAt: inserted[0].createdAt,
      },
    });
  } catch (err: any) {
    console.error("[SalesCoach] session POST failed:", err?.message || err);
    return NextResponse.json({ ok: false, error: err?.message || "failed" }, { status: 500 });
  }
}
