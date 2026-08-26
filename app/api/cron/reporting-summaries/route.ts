import { NextRequest, NextResponse } from "next/server";
import { deliverDueReportingSubscriptions } from "@/lib/reporting-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await deliverDueReportingSubscriptions()) });
  } catch (error) {
    console.error("[reporting-summaries]", error);
    return NextResponse.json({ ok: false, error: "Reporting summary delivery failed" }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;