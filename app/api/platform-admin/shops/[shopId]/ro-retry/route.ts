import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { retryShopSkippedRos } from "@/app/api/cron/tekmetric-ro-retry/route";
import { resetTekmetricApiCallCount } from "@/lib/integrations/tekmetric/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: { shopId: string } },
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(params.shopId);
  if (isNaN(shopId)) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  if (!process.env.TEKMETRIC_CLIENT_ID || !process.env.TEKMETRIC_CLIENT_SECRET) {
    return NextResponse.json(
      { error: "Tekmetric OAuth credentials not configured" },
      { status: 500 },
    );
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId });
  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }

  const startTime = Date.now();
  resetTekmetricApiCallCount();

  try {
    console.log(
      `[Platform Admin] On-demand Tekmetric RO retry for shop ${shopId} by ${session.email}`,
    );
    const result = await retryShopSkippedRos(db, shopId);
    const apiCalls = resetTekmetricApiCallCount();
    const duration = Date.now() - startTime;

    await db.collection("audit_logs").insertOne({
      type: "manual_ro_retry_triggered",
      shopId,
      shopName: shop.name,
      adminEmail: session.email,
      attempted: result.attempted,
      recovered: result.recovered,
      stillFailing: result.stillFailing,
      permanentlyFailed: result.permanentlyFailed,
      reason: result.reason || null,
      createdAt: new Date(),
    });

    console.log(
      `[Platform Admin] RO retry shop ${shopId}: attempted=${result.attempted} recovered=${result.recovered} stillFailing=${result.stillFailing} permanentlyFailed=${result.permanentlyFailed} (API calls: ${apiCalls}, ${duration}ms)`,
    );

    return NextResponse.json({
      ok: true,
      ...result,
      tekmetricApiCalls: apiCalls,
      duration: `${duration}ms`,
    });
  } catch (err: any) {
    const apiCalls = resetTekmetricApiCallCount();
    console.error(`[Platform Admin] RO retry failed for shop ${shopId}:`, err);
    return NextResponse.json(
      { error: err.message || "RO retry failed", tekmetricApiCalls: apiCalls },
      { status: 500 },
    );
  }
}
