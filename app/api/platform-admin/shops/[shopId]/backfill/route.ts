import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { runProtractorBackfill } from "@/lib/integrations/protractor-backfill";

export const dynamic = "force-dynamic";

function detectIntegrationType(shop: any): "protractor" | "tekmetric" | "shopware" | null {
  if (shop.integrationProvider === "tekmetric") return "tekmetric";
  if (shop.integrationProvider === "protractor") return "protractor";
  if (shop.integrationProvider === "shopware") return "shopware";

  const hasTekmetric = !!(shop.tekmetric?.shopId || shop.tekmetricShopId);
  const hasProtractor = !!(
    shop.protractor?.configured ||
    shop.protractor?.apiKey ||
    shop.protractor?.connectionId ||
    shop.protractorApiKey ||
    shop.protractorConnectionId
  );
  const hasShopWare = !!(shop.shopware?.tenantId);
  
  if (hasTekmetric) return "tekmetric";
  if (hasProtractor) return "protractor";
  if (hasShopWare) return "shopware";
  return null;
}

async function triggerShopWareBackfill(shopId: number): Promise<{ ok: boolean; message: string }> {
  const db = await getDb();

  await db.collection("shopware_backfill_progress").updateOne(
    { shopId },
    {
      $set: {
        shopId,
        completed: false,
        inProgress: false,
        currentCursor: null,
        queuedAt: new Date(),
      },
      $setOnInsert: { startedAt: null },
    },
    { upsert: true }
  );

  try {
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:5000";

    fetch(`${baseUrl}/api/cron/shopware-backfill?shopId=${shopId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET || ""}`,
      },
    }).catch((err) => {
      console.log(`[Backfill] Shop-Ware cron trigger note: ${err.message}`);
    });
  } catch (e) {
    // fire-and-forget
  }

  return { ok: true, message: `Shop-Ware backfill triggered for shop ${shopId}` };
}

async function triggerTekmetricBackfill(shopId: number): Promise<{ ok: boolean; message: string }> {
  const db = await getDb();

  await db.collection("tekmetric_backfill_progress").updateOne(
    { shopId },
    { 
      $set: { 
        shopId,
        completed: false,
        inProgress: false,
        queuedAt: new Date(),
        logicVersion: 2
      },
      $setOnInsert: { startedAt: null }
    },
    { upsert: true }
  );

  await db.collection("shops").updateOne(
    { shopId },
    { $set: { tekmetricBackfillComplete: false } }
  );

  try {
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:5000";
    
    fetch(`${baseUrl}/api/cron/tekmetric-backfill`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET || ""}`,
      },
    }).catch(err => {
      console.log(`[Backfill] Tekmetric cron trigger note: ${err.message}`);
    });
  } catch (e) {
    // fire-and-forget
  }

  return { ok: true, message: `Tekmetric backfill triggered for shop ${shopId}` };
}

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

    const integrationType = detectIntegrationType(shop);

    if (!integrationType) {
      return NextResponse.json(
        { error: "Shop does not have any SMS integration configured (Protractor, Tekmetric, or Shop-Ware)" },
        { status: 400 }
      );
    }

    console.log(`[Platform Admin] Triggering ${integrationType} backfill for shop ${shopId} by ${session.email}`);

    if (integrationType === "protractor") {
      runProtractorBackfill(shopId)
        .then((result) => {
          console.log(`[Platform Admin] Protractor backfill completed for shop ${shopId}:`, result);
        })
        .catch((err) => {
          console.error(`[Platform Admin] Protractor backfill failed for shop ${shopId}:`, err.message);
        });
    } else if (integrationType === "shopware") {
      const result = await triggerShopWareBackfill(shopId);
      console.log(`[Platform Admin] ${result.message}`);
    } else {
      const result = await triggerTekmetricBackfill(shopId);
      console.log(`[Platform Admin] ${result.message}`);
    }

    await db.collection("audit_logs").insertOne({
      type: "manual_backfill_triggered",
      shopId,
      shopName: shop.name,
      integrationType,
      adminEmail: session.email,
      createdAt: new Date(),
    });

    const providerName = integrationType === "protractor" ? "Protractor" : integrationType === "shopware" ? "Shop-Ware" : "Tekmetric";
    return NextResponse.json({
      ok: true,
      message: `${providerName} backfill started for shop ${shopId}. Check logs for progress.`,
      source: integrationType,
    });
  } catch (error) {
    console.error("[Platform Admin] Backfill trigger error:", error);
    return NextResponse.json({ error: "Failed to trigger backfill" }, { status: 500 });
  }
}
