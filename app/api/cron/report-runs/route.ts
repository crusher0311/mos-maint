import { NextRequest, NextResponse } from "next/server";
import { processNextReportRun, refreshActiveReports } from "@/lib/report-run-service";
import { processTireRunBatch } from "@/lib/tire-dot-report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const refreshed = await refreshActiveReports();
  // Keep scheduled refresh admission; move execution off the web process only
  // after an operator has staged the dedicated worker.
  if (process.env.REPORTING_QUEUE_WORKER_ENABLED === "true") {
    return NextResponse.json({ ok: true, refreshed, execution: "dedicated-worker" });
  }
  const tireDot = await processTireRunBatch();
  return NextResponse.json({ ok: true, refreshed, tireDot, ...(await processNextReportRun()) });
}
export const GET = handle;
export const POST = handle;