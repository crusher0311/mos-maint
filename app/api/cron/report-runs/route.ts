import { NextRequest, NextResponse } from "next/server";
import { processNextReportRun, refreshActiveReports } from "@/lib/report-run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const refreshed = await refreshActiveReports();
  return NextResponse.json({ ok: true, refreshed, ...(await processNextReportRun()) });
}
export const GET = handle;
export const POST = handle;