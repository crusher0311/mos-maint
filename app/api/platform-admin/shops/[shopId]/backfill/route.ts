import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
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
    const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${String(shopId)}`;
    const shop = shopRows[0] as any;

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const hasProtractor = !!(
      shop.protractor_configured ||
      shop.protractor_api_key ||
      shop.protractor_connection_id
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

    await sql`
      INSERT INTO audit_logs (type, shop_id, shop_name, admin_email, created_at)
      VALUES ('manual_backfill_triggered', ${String(shopId)}, ${shop.name}, ${session.email}, NOW())
    `;

    return NextResponse.json({
      ok: true,
      message: `Backfill started for shop ${shopId}. Check logs for progress.`,
    });
  } catch (error) {
    console.error("[Platform Admin] Backfill trigger error:", error);
    return NextResponse.json({ error: "Failed to trigger backfill" }, { status: 500 });
  }
}
