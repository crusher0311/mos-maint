import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { runRetry } from "@/app/api/cron/tekmetric-ro-retry/route";
import { resetTekmetricApiCallCount } from "@/lib/integrations/tekmetric/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.TEKMETRIC_CLIENT_ID || !process.env.TEKMETRIC_CLIENT_SECRET) {
    return NextResponse.json(
      { error: "Tekmetric OAuth credentials not configured" },
      { status: 500 },
    );
  }

  const db = await getDb();
  const startTime = Date.now();
  resetTekmetricApiCallCount();

  try {
    console.log(
      `[Platform Admin] On-demand Tekmetric RO retry (all shops) by ${session.email}`,
    );
    const summary = await runRetry(db);
    const apiCalls = resetTekmetricApiCallCount();
    const duration = Date.now() - startTime;

    await db.collection("audit_logs").insertOne({
      type: "manual_ro_retry_all_triggered",
      adminEmail: session.email,
      shopsConsidered: summary.shopsConsidered,
      shopsProcessed: summary.shopsProcessed,
      totalAttempted: summary.totalAttempted,
      totalRecovered: summary.totalRecovered,
      totalStillFailing: summary.totalStillFailing,
      totalPermanentlyFailed: summary.totalPermanentlyFailed,
      createdAt: new Date(),
    });

    console.log(
      `[Platform Admin] RO retry all: ${summary.totalRecovered} recovered, ${summary.totalStillFailing} still failing, ${summary.totalPermanentlyFailed} permanently failed (API calls: ${apiCalls}, ${duration}ms)`,
    );

    return NextResponse.json({
      ok: true,
      ...summary,
      tekmetricApiCalls: apiCalls,
      duration: `${duration}ms`,
    });
  } catch (err: any) {
    const apiCalls = resetTekmetricApiCallCount();
    console.error("[Platform Admin] RO retry all failed:", err);
    return NextResponse.json(
      { error: err.message || "RO retry failed", tekmetricApiCalls: apiCalls },
      { status: 500 },
    );
  }
}
