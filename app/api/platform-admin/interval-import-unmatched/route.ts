// app/api/platform-admin/interval-import-unmatched/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  clearUnmatchedIntervalImportTally,
  getUnmatchedIntervalImportTally,
} from "@/lib/interval-import-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/platform-admin/interval-import-unmatched
 *
 * Returns the in-memory tally of maintenance-guide document service names
 * that did not resolve to any canonical service key during Settings →
 * Intervals document imports. Lets an operator review which wordings still
 * need a synonym (lib/service-keys.ts) or a manual override so the import
 * stops flagging them as unrecognized. Mirrors the CARFAX match-gap route
 * (carfax-unmatched).
 *
 * Placed under the /platform-admin realm (not /admin) so it uses platform
 * admin auth and doesn't bounce operators to /dashboard.
 *
 * Tally is per Node process and resets on redeploy.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json(
      { ok: false, error: "Platform admin access required" },
      { status: 403 },
    );
  }

  const entries = getUnmatchedIntervalImportTally();
  return NextResponse.json({
    ok: true,
    count: entries.length,
    entries,
    note: "In-memory per Node process; resets on redeploy.",
  });
}

/**
 * DELETE /api/platform-admin/interval-import-unmatched
 *
 * Clear the tally — useful after a sweep where new wordings have been
 * added to the dictionary (or saved as overrides) and you want to start
 * fresh.
 */
export async function DELETE() {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json(
      { ok: false, error: "Platform admin access required" },
      { status: 403 },
    );
  }

  clearUnmatchedIntervalImportTally();
  return NextResponse.json({ ok: true, cleared: true });
}
