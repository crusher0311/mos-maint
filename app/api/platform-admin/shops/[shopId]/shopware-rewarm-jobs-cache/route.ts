import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { prewarmShopWareJobsCacheForOnboarding } from "@/lib/shopware-jobs-prewarm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Pre-warm issues a paginated `/repair_orders?associations=…` list +
// per-RO write fan-out (capped at 1000 ROs in
// lib/shopware-jobs-prewarm.ts) and on a cold shop with rate-limit
// backoff this can take a couple of minutes. Match the 5-minute
// ceiling the bulk Shop-Ware rewarm endpoint uses.
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

  const tenantId = Number(shop?.shopware?.tenantId);
  const swShopId = Number(shop?.shopware?.swShopId);
  if (!tenantId || Number.isNaN(tenantId)) {
    return NextResponse.json(
      { error: "Shop is not connected to Shop-Ware (missing tenantId)" },
      { status: 400 },
    );
  }
  if (!swShopId || Number.isNaN(swShopId)) {
    return NextResponse.json(
      { error: "Shop is not connected to Shop-Ware (missing swShopId)" },
      { status: 400 },
    );
  }

  console.log(
    `[Platform Admin] Shop-Ware jobs-cache re-warm requested for shop ${shopId} (tenant ${tenantId} / sw ${swShopId}) by ${session.email}`,
  );

  await db.collection("audit_logs").insertOne({
    type: "shopware_jobs_cache_rewarm",
    shopId,
    tenantId,
    swShopId,
    shopName: shop.name,
    adminEmail: session.email,
    createdAt: new Date(),
  });

  try {
    const result = await prewarmShopWareJobsCacheForOnboarding(
      shopId,
      tenantId,
      swShopId,
    );
    return NextResponse.json({
      ok: true,
      shopId,
      shopName: shop.name,
      result,
    });
  } catch (err: any) {
    console.error(
      `[Platform Admin] Shop-Ware jobs-cache re-warm failed for shop ${shopId}:`,
      err,
    );
    return NextResponse.json(
      { error: err?.message || "Failed to re-warm Shop-Ware jobs cache" },
      { status: 500 },
    );
  }
}
