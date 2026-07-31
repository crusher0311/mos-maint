// Streams a practice session's stored audio (task #987). Platform-admin only.
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db/drizzle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!session.isPlatformAdmin) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  try {
    const db = getDb();
    const rows: any[] = await db.execute(sql`
      SELECT audio, audio_mime FROM sales_coach_sessions WHERE id = ${params.id}
    `);
    const row = rows[0];
    if (!row || !row.audio) {
      return NextResponse.json({ ok: false, error: "Audio not found" }, { status: 404 });
    }
    const buf: Buffer = Buffer.isBuffer(row.audio) ? row.audio : Buffer.from(row.audio);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": row.audio_mime || "audio/webm",
        "Content-Length": String(buf.length),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err: any) {
    console.error("[SalesCoach] audio GET failed:", err?.message || err);
    return NextResponse.json({ ok: false, error: err?.message || "failed" }, { status: 500 });
  }
}
