import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { retryAutoflowDashboardNotifications } from "@/lib/data/repositories/autoflow-dashboard-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const expected = Buffer.from(secret ? `Bearer ${secret}` : "");
  const actual = Buffer.from(request.headers.get("authorization") || "");
  if (!secret || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const handled = await retryAutoflowDashboardNotifications();
    return NextResponse.json({ ok: true, handled });
  } catch {
    console.warn("[AutoFlow Dashboard Outbox] Retry pass unavailable");
    return NextResponse.json({ error: "Dashboard notification retry unavailable" }, { status: 503 });
  }
}