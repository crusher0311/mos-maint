/**
 * Pre-cutover readiness check endpoint (task #567).
 *
 * Platform-admin only. Thin JSON over `lib/queue/readiness.ts` so the
 * admin dashboard (and any browser-authenticated operator) gets the same
 * go/no-go verdict the CLI script (`scripts/queue-readiness-check.ts`)
 * prints. Read-only and never throws — a Redis hiccup shows up as
 * `redis.reachable: false` with a blocker, not a 500.
 */

import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getQueueReadiness } from "@/lib/queue/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const readiness = await getQueueReadiness();
  return NextResponse.json(readiness);
}
