import { NextRequest, NextResponse } from "next/server";
import {
  syncLogsFromBetterStack,
  purgeOldLogs,
} from "@/lib/logs/betterstack-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_SYNC_MINUTES = 120;
const DEFAULT_SYNC_MINUTES = 20;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    if (process.env.NODE_ENV === "production") {
      console.error("[LogSync] CRON_SECRET not configured");
      return NextResponse.json({ error: "Not configured" }, { status: 500 });
    }
  } else if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawMinutes = parseInt(
    request.nextUrl.searchParams.get("minutes") || String(DEFAULT_SYNC_MINUTES),
  );
  const minutes =
    isNaN(rawMinutes) || rawMinutes < 1
      ? DEFAULT_SYNC_MINUTES
      : Math.min(rawMinutes, MAX_SYNC_MINUTES);

  try {
    const syncResult = await syncLogsFromBetterStack(minutes);
    const purged = await purgeOldLogs();

    console.log(
      `[LogSync] Synced: ${syncResult.inserted} inserted, ${syncResult.skipped} skipped, ${syncResult.errors} errors. Purged: ${purged} old logs.`,
    );

    return NextResponse.json({
      success: true,
      sync: syncResult,
      purged,
    });
  } catch (err: any) {
    console.error("[LogSync] Cron error:", err.message);
    return NextResponse.json(
      { error: "Sync failed" },
      { status: 500 },
    );
  }
}
