import { NextRequest, NextResponse } from "next/server";
import {
  syncLogsFromBetterStack,
  purgeOldLogs,
  checkLogFreshness,
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

    // Report ACTUAL new rows vs rows fetched. A run that pulls a batch already
    // in the table now reads "0 new (N fetched)" instead of a misleading
    // "N inserted", so a frozen feed is visible in the logs.
    console.log(
      `[LogSync] Synced: ${syncResult.inserted} new (${syncResult.fetched} fetched), ${syncResult.skipped} skipped, ${syncResult.errors} errors. Purged: ${purged} old logs.`,
    );

    // Data-freshness guard — pages via [OPS-ALERT] if the feed is frozen even
    // though this run "succeeded". Never let it break the cron response.
    let freshness = null;
    try {
      freshness = await checkLogFreshness();
      if (freshness.stale) {
        console.warn(
          `[LogSync] Feed stale: latest=${freshness.latest} lag=${freshness.lagMinutes}min (threshold ${freshness.thresholdMinutes}min, alerted=${freshness.alerted}).`,
        );
      }
    } catch (freshErr: any) {
      console.error("[LogSync] Freshness check failed:", freshErr.message);
    }

    return NextResponse.json({
      success: true,
      sync: syncResult,
      purged,
      freshness,
    });
  } catch (err: any) {
    console.error("[LogSync] Cron error:", err.message);
    return NextResponse.json(
      { error: "Sync failed" },
      { status: 500 },
    );
  }
}
