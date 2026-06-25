import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  detectBackfillProvider,
  triggerBackfillForShop,
} from "@/lib/backfill/trigger";

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
  if (isNaN(shopId)) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  try {
    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const integrationType = detectBackfillProvider(shop);

    if (!integrationType) {
      return NextResponse.json(
        {
          error:
            "Shop does not have any SMS integration configured (Protractor, Tekmetric, or Shop-Ware)",
        },
        { status: 400 },
      );
    }

    console.log(
      `[Platform Admin] Triggering ${integrationType} backfill for shop ${shopId} by ${session.email}`,
    );

    const result = await triggerBackfillForShop(db, shopId, integrationType);
    console.log(`[Platform Admin] ${result.message}`);

    await db.collection("audit_logs").insertOne({
      type: "manual_backfill_triggered",
      shopId,
      shopName: shop.name,
      integrationType,
      adminEmail: session.email,
      createdAt: new Date(),
    });

    const providerName =
      integrationType === "protractor"
        ? "Protractor"
        : integrationType === "shopware"
          ? "Shop-Ware"
          : "Tekmetric";
    return NextResponse.json({
      ok: true,
      message: `${providerName} backfill started for shop ${shopId}. Check logs for progress.`,
      source: integrationType,
    });
  } catch (error) {
    console.error("[Platform Admin] Backfill trigger error:", error);
    return NextResponse.json(
      { error: "Failed to trigger backfill" },
      { status: 500 },
    );
  }
}
