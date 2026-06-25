import "server-only";
import type { Db } from "mongodb";
import { runProtractorBackfill } from "@/lib/integrations/protractor/sync";

// Shared backfill trigger (task #629 follow-on). Encapsulates the
// "reset cursor + kick the provider cron" logic so both the platform-admin
// manual-backfill endpoint and the customer-requested overnight re-sync
// consumer use the exact same, proven path instead of duplicating it.

export type BackfillProvider = "protractor" | "tekmetric" | "shopware";

export function detectBackfillProvider(shop: any): BackfillProvider | null {
  if (!shop) return null;

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
  const hasShopWare = !!shop.shopware?.tenantId;

  if (hasTekmetric) return "tekmetric";
  if (hasProtractor) return "protractor";
  if (hasShopWare) return "shopware";
  return null;
}

function cronBaseUrl(): string {
  return (
    process.env.RENDER_EXTERNAL_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : null) ||
    process.env.NEXT_PUBLIC_APP_URL ||
    `http://localhost:${process.env.PORT || 5000}`
  );
}

export interface TriggerResult {
  ok: boolean;
  provider: BackfillProvider | null;
  message: string;
}

// Reset the relevant progress cursor and kick the provider's backfill cron.
// Pass an explicit `provider` to skip the shop lookup; otherwise the shop doc
// is loaded and the provider detected. This mirrors the platform-admin
// manual-backfill behavior exactly (Protractor runs in-process fire-and-forget;
// Tekmetric / Shop-Ware reset their progress doc and trigger the cron).
export async function triggerBackfillForShop(
  db: Db,
  shopId: number,
  provider?: BackfillProvider | null,
): Promise<TriggerResult> {
  let p: BackfillProvider | null = provider ?? null;
  if (!p) {
    const shop = await db
      .collection("shops")
      .findOne({ shopId: { $in: [shopId, String(shopId)] } });
    p = detectBackfillProvider(shop);
  }

  if (!p) {
    return {
      ok: false,
      provider: null,
      message: `Shop ${shopId} has no backfillable SMS integration (Protractor, Tekmetric, or Shop-Ware)`,
    };
  }

  if (p === "protractor") {
    runProtractorBackfill(shopId)
      .then((result) => {
        console.log(
          `[Backfill] Protractor backfill completed for shop ${shopId}:`,
          result,
        );
      })
      .catch((err) => {
        console.error(
          `[Backfill] Protractor backfill failed for shop ${shopId}:`,
          err?.message ?? err,
        );
      });
    return {
      ok: true,
      provider: p,
      message: `Protractor backfill started for shop ${shopId}`,
    };
  }

  if (p === "shopware") {
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
      { upsert: true },
    );

    fetch(`${cronBaseUrl()}/api/cron/shopware-backfill?shopId=${shopId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET || ""}` },
    }).catch((err) => {
      console.log(`[Backfill] Shop-Ware cron trigger note: ${err.message}`);
    });

    return {
      ok: true,
      provider: p,
      message: `Shop-Ware backfill triggered for shop ${shopId}`,
    };
  }

  // tekmetric
  const eod = new Date();
  eod.setHours(23, 59, 59, 999);

  await db.collection("tekmetric_backfill_progress").updateOne(
    { shopId },
    {
      $set: {
        shopId,
        completed: false,
        inProgress: false,
        currentChunkEnd: eod,
        queuedAt: new Date(),
        logicVersion: 2,
      },
      $setOnInsert: { startedAt: null },
    },
    { upsert: true },
  );

  await db
    .collection("shops")
    .updateOne({ shopId }, { $set: { tekmetricBackfillComplete: false } });

  fetch(`${cronBaseUrl()}/api/cron/tekmetric-backfill`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET || ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ shopId }),
  }).catch((err) => {
    console.log(`[Backfill] Tekmetric cron trigger note: ${err.message}`);
  });

  return {
    ok: true,
    provider: p,
    message: `Tekmetric backfill triggered for shop ${shopId}`,
  };
}
