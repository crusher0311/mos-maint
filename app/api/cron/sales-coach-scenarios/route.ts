// Daily sales-coach scenario sampler (task #987, feature/sales-coach).
// Follows the standard cron-route pattern: Bearer CRON_SECRET (or ?secret=),
// GET/POST both accepted. Idempotent per UTC day.
import { NextRequest, NextResponse } from "next/server";
import { generateDailyScenarios } from "@/lib/sales-coach/scenario-sampler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

async function handle(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const secretParam = req.nextUrl.searchParams.get("secret");
  const isAuthorized =
    (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) ||
    (CRON_SECRET && secretParam === CRON_SECRET) ||
    !CRON_SECRET;
  if (!isAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await generateDailyScenarios(5);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[Cron] sales-coach-scenarios failed:", err?.message || err);
    return NextResponse.json({ ok: false, error: err?.message || "failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
