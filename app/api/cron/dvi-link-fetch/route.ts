/**
 * Task #860: DVI share-link fetch cron.
 *
 * Fetches + snapshots + parses pending DVI share links registered by the
 * Protractor sync hook (lib/dvi-links/ingest.ts). Bounded per run and paced
 * politely (1s between outbound fetches), so a large discovery burst drains
 * over a few runs instead of hammering the DVI providers.
 *
 * SAFETY: fully dormant unless DVI_LINK_INGEST_ENABLED=true (default OFF) —
 * both this route AND the registration hook check the flag, so nothing is
 * fetched or written until an operator flips it in production.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchPendingDviLinks, isDviLinkIngestEnabled } from "@/lib/dvi-links/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

// Same auth contract as the other cron routes: the in-process scheduler sends
// `Authorization: Bearer ${CRON_SECRET}`; a `?secret=` query param is accepted
// for manual curl triggers. When CRON_SECRET is unset (dev) auth is a no-op.
function authorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return true;
  const header = req.headers.get("authorization");
  const param = new URL(req.url).searchParams.get("secret");
  return header === `Bearer ${CRON_SECRET}` || param === CRON_SECRET;
}

/** Links per run — with 1s pacing this stays well inside the cron timeout. */
const LINKS_PER_RUN = 50;

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isDviLinkIngestEnabled()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "DVI_LINK_INGEST_ENABLED is not 'true'",
    });
  }

  const started = Date.now();
  try {
    const result = await fetchPendingDviLinks(LINKS_PER_RUN);
    return NextResponse.json({
      ...result,
      ok: true,
      durationMs: Date.now() - started,
    });
  } catch (e: any) {
    console.error(`[DviLinks] cron fetch pass failed: ${e?.message || e}`);
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 },
    );
  }
}
