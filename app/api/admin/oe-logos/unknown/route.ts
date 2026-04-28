// app/api/admin/oe-logos/unknown/route.ts
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  clearUnmatchedMakeTally,
  getUnmatchedMakeTally,
} from "@/lib/oe-logos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/oe-logos/unknown
 *
 * Returns the in-memory tally of vehicle-make strings that hit
 * `getOELogoUrl` and didn't resolve to a logo. Lets on-call review which
 * makes need a new alias or a logo asset added.
 *
 * Tally is per Node process and resets on redeploy.
 */
export async function GET() {
  const session = await requireSession();
  if (session.role !== "admin") {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 },
    );
  }

  const entries = getUnmatchedMakeTally();
  return NextResponse.json({
    ok: true,
    count: entries.length,
    entries,
    note: "In-memory per Node process; resets on redeploy.",
  });
}

/**
 * DELETE /api/admin/oe-logos/unknown
 *
 * Clear the tally — useful after an on-call sweep where new aliases /
 * assets have been added and you want to start fresh.
 */
export async function DELETE() {
  const session = await requireSession();
  if (session.role !== "admin") {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 },
    );
  }

  clearUnmatchedMakeTally();
  return NextResponse.json({ ok: true, cleared: true });
}
