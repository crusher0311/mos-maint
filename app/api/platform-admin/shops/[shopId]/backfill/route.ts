import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { runProtractorBackfill } from "@/lib/integrations/protractor-backfill";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(params.shopId);
  if (isNaN(shopId)) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  try {
    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const hasProtractor = !!(
      shop.protractor?.configured ||
      shop.protractor?.apiKey ||
      shop.protractorApiKey ||
      shop.protractorConnectionId
    );

    if (!hasProtractor) {
      return NextResponse.json(
        { error: "Shop does not have Protractor configured" },
        { status: 400 }
      );
    }

    console.log(`[Platform Admin] Triggering backfill for shop ${shopId} by ${session.email}`);

    runProtractorBackfill(shopId)
      .then((result) => {
        console.log(`[Platform Admin] Backfill completed for shop ${shopId}:`, result);
      })
      .catch((err) => {
        console.error(`[Platform Admin] Backfill failed for shop ${shopId}:`, err.message);
      });

    await db.collection("audit_logs").insertOne({
      type: "manual_backfill_triggered",
      shopId,
      shopName: shop.name,
      adminEmail: session.email,
      createdAt: new Date(),
    });

    return NextResponse.json({
      ok: true,
      message: `Backfill started for shop ${shopId}. Check logs for progress.`,
    });
  } catch (error) {
    console.error("[Platform Admin] Backfill trigger error:", error);
    return NextResponse.json({ error: "Failed to trigger backfill" }, { status: 500 });
  }
}
