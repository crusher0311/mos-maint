import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { prewarmProtractorJobsCacheForOnboarding } from "@/lib/protractor-jobs-prewarm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Pre-warm fans out per-invoice `/Invoice/{id}` calls (capped at 500
// invoices / concurrency 3 in lib/protractor-jobs-prewarm.ts) and on a
// cold shop with rate-limit backoff this can take a couple of minutes.
// Match the 5-minute ceiling the Tekmetric jobs-cache rewarm endpoint
// uses for the same reason.
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

  // Mirror the sync-health route's Protractor-shop join filter
  // (`protractor.configured: true`) so a non-Protractor shop fails fast
  // instead of erroring inside `resolveProtractorConfig`.
  if (!shop?.protractor?.configured) {
    return NextResponse.json(
      { error: "Shop is not connected to Protractor" },
      { status: 400 },
    );
  }

  console.log(
    `[Platform Admin] Protractor invoice-cache re-warm requested for shop ${shopId} by ${session.email}`,
  );

  await db.collection("audit_logs").insertOne({
    type: "protractor_invoice_cache_rewarm",
    shopId,
    shopName: shop.name,
    adminEmail: session.email,
    createdAt: new Date(),
  });

  try {
    const result = await prewarmProtractorJobsCacheForOnboarding(shopId);
    return NextResponse.json({
      ok: true,
      shopId,
      shopName: shop.name,
      result,
    });
  } catch (err: any) {
    console.error(
      `[Platform Admin] Protractor invoice-cache re-warm failed for shop ${shopId}:`,
      err,
    );
    return NextResponse.json(
      { error: err?.message || "Failed to re-warm invoice cache" },
      { status: 500 },
    );
  }
}
