import { NextRequest, NextResponse } from "next/server";
import { findAndResumeStaleBackfills } from "@/lib/integrations/protractor-backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("[Protractor Backfill Cron] Checking for stale backfills...");
    
    const result = await findAndResumeStaleBackfills();
    
    console.log(`[Protractor Backfill Cron] Resumed ${result.resumed} stale backfills:`, result.shopIds);
    
    return NextResponse.json({
      ok: true,
      resumed: result.resumed,
      shopIds: result.shopIds,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Protractor Backfill Cron] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
