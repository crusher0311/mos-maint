// app/api/platform-admin/carfax-unmatched/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  clearUnmatchedCarfaxTally,
  getUnmatchedCarfaxTally,
} from "@/lib/carfax-match-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Task #655.
 *
 * GET /api/platform-admin/carfax-unmatched
 *
 * Returns the in-memory tally of CARFAX service descriptions that did not
 * resolve to any canonical service key during plan builds. Lets an operator
 * review which wordings still need to be added to `SERVICE_KEYS`
 * (lib/service-keys.ts) so CARFAX work stops showing as "not done" in VHI.
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

  const entries = getUnmatchedCarfaxTally();
  return NextResponse.json({
    ok: true,
    count: entries.length,
    entries,
    note: "In-memory per Node process; resets on redeploy.",
  });
}

/**
 * DELETE /api/platform-admin/carfax-unmatched
 *
 * Clear the tally — useful after a sweep where new wordings have been added
 * to the dictionary and you want to start fresh.
 */
export async function DELETE() {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json(
      { ok: false, error: "Platform admin access required" },
      { status: 403 },
    );
  }

  clearUnmatchedCarfaxTally();
  return NextResponse.json({ ok: true, cleared: true });
}
