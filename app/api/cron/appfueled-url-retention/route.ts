import { NextRequest, NextResponse } from "next/server";
import { cleanupExpiredAppFueledReceipts } from "@/lib/data/repositories/appfueled-url-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** Scheduled retention enforcement; it is deliberately not tied to admin reads. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  // Fail closed in development too: this project's development environment
  // can point at the live stores. Missing cron configuration is never auth.
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await cleanupExpiredAppFueledReceipts()) });
  } catch {
    console.error("[AppFueledUrlRetention] cleanup failed");
    return NextResponse.json({ error: "Retention cleanup failed" }, { status: 500 });
  }
}