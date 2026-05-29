/**
 * Platform-admin ZINK Print fleet overview (task #543, Milestone 3).
 *
 *   GET /api/platform-admin/zink-print  -> { ok, shops: FleetShopRow[] }
 *
 * Returns every shop with a ZINK print footprint (configured printer, agent
 * heartbeat, or queued jobs): printer config(s), agent online status, job
 * status counts, and a recent-job sample. The base64 image payload is never
 * shipped. Read-only; controls live on the sibling config/jobs routes.
 */

import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  getFleetPrintOverview,
  type FleetShopRow,
} from "@/lib/print-queue/repository";
import { AGENT_ONLINE_THRESHOLD_MS } from "@/lib/print-queue/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requirePlatformAdmin();
    const shops: FleetShopRow[] = await getFleetPrintOverview({ recentLimit: 20 });
    return NextResponse.json({
      ok: true,
      onlineThresholdMs: AGENT_ONLINE_THRESHOLD_MS,
      shops,
    });
  } catch (error: any) {
    if (
      typeof error?.digest === "string" &&
      error.digest.startsWith("NEXT_REDIRECT")
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[Admin ZINK Print] overview error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to load print overview" },
      { status: 500 },
    );
  }
}
