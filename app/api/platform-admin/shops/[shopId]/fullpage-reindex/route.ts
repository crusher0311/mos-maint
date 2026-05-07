/**
 * Platform-admin trigger for the Tekmetric full-page reindex.
 *
 * Distinct from the existing /backfill endpoint: that one resets the
 * date-window chunker's cursor and re-runs the same broken-for-migrated-shops
 * logic. This endpoint flags the shop into full-page mode (no date filter,
 * paginate `/repair-orders` by id ASC) and kicks the dedicated cron, which
 * is the only path that recovers the missing history for shops whose ROs
 * all share recent updatedDates (Casey, Duxler, etc).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { flagShopForFullPageReindex } from "@/lib/integrations/tekmetric/full-page-backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { shopId: string } },
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(params.shopId);
  if (!Number.isFinite(shopId) || shopId <= 0) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId });
  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }

  const tekmetricShopId =
    Number(shop.tekmetric?.shopId) || Number(shop.tekmetricShopId);
  if (!Number.isFinite(tekmetricShopId) || tekmetricShopId <= 0) {
    return NextResponse.json(
      {
        error:
          "Shop is not connected to Tekmetric (no tekmetric.shopId). Full-page reindex only applies to Tekmetric shops.",
      },
      { status: 400 },
    );
  }

  const reason = `manual trigger by ${session.email || "platform admin"}`;
  await flagShopForFullPageReindex(db, shopId, reason);

  // Fire-and-forget kick of the dedicated full-page cron so the user sees
  // progress within a minute instead of waiting for the next scheduled tick.
  // The cron is locked-stamped, so a duplicate kick is a no-op.
  try {
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:5000";
    fetch(`${baseUrl}/api/cron/tekmetric-fullpage-backfill`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET || ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ shopId }),
    }).catch((err) => {
      console.log(
        `[Platform Admin] Full-page cron kick note: ${err.message}`,
      );
    });
  } catch {
    // fire-and-forget
  }

  await db.collection("audit_logs").insertOne({
    type: "manual_fullpage_reindex_triggered",
    shopId,
    shopName: shop.name,
    tekmetricShopId,
    adminEmail: session.email,
    createdAt: new Date(),
  });

  console.log(
    `[Platform Admin] Full-page reindex queued for shop ${shopId} (Tek ${tekmetricShopId}) by ${session.email}`,
  );

  return NextResponse.json({
    ok: true,
    message: `Full-page reindex queued for shop ${shopId}. The cron will paginate Tekmetric's /repair-orders endpoint with no date filter and may take many hours for shops with 100k+ ROs.`,
    shopId,
    tekmetricShopId,
  });
}
