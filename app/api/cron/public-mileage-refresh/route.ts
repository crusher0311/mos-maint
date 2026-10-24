import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { drainPublicMileageRefresh } from "@/lib/public-report-service";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const expected = Buffer.from(secret ? `Bearer ${secret}` : "");
  const actual = Buffer.from(req.headers.get("authorization") || "");
  if (!secret || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return withUpstreamTimeout<NextResponse>(
    drainPublicMileageRefresh().then(handled => NextResponse.json({ ok: true, handled })),
    25_000, "public mileage queue",
    NextResponse.json({ error: "Refresh unavailable; queued mileage retained" }, { status: 503 }),
  );
}
