import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { prewarmTekmetricJobsCacheForOnboarding } from "@/lib/tekmetric-jobs-prewarm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Pre-warm fans out per-RO `/jobs` calls (capped at 500 ROs / concurrency
// 3 in lib/tekmetric-jobs-prewarm.ts) and on a cold shop with rate-limit
// backoff this can take a couple of minutes. Match the 5-minute ceiling
// the Tekmetric run-now endpoint uses for the same reason.
export const maxDuration = 300;

export async function POST(
  _req: NextRequest,
  { params }: { params: { shopId: string } },
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(params.shopId);
  if (Number.isNaN(shopId)) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({
    shopId: { $in: [shopId, String(shopId)] },
  });
  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }

  const tekmetricShopId = Number(
    shop?.tekmetric?.shopId ?? shop?.tekmetricShopId,
  );
  if (!tekmetricShopId || Number.isNaN(tekmetricShopId)) {
    return NextResponse.json(
      { error: "Shop is not connected to Tekmetric" },
      { status: 400 },
    );
  }

  console.log(
    `[Platform Admin] Tekmetric jobs-cache re-warm requested for shop ${shopId} (tek ${tekmetricShopId}) by ${session.email}`,
  );

  await db.collection("audit_logs").insertOne({
    type: "tekmetric_jobs_cache_rewarm",
    shopId,
    tekmetricShopId,
    shopName: shop.name,
    adminEmail: session.email,
    createdAt: new Date(),
  });

  try {
    const result = await prewarmTekmetricJobsCacheForOnboarding(
      shopId,
      tekmetricShopId,
    );
    return NextResponse.json({
      ok: true,
      shopId,
      shopName: shop.name,
      result,
    });
  } catch (err: any) {
    console.error(
      `[Platform Admin] Tekmetric jobs-cache re-warm failed for shop ${shopId}:`,
      err,
    );
    return NextResponse.json(
      { error: err?.message || "Failed to re-warm jobs cache" },
      { status: 500 },
    );
  }
}
