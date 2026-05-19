/**
 * One-time operational script for Task #456.
 *
 * State Street Auto Service (MOS shop 136 / Shop-Ware tenant 5700, swShopId
 * 6194) had its webhook registered as `https://0.0.0.0:10000/api/webhooks/shopware`
 * because the original register-webhook handler derived the URL from
 * `req.nextUrl.origin` (the internal bind address on the deployed server).
 * The handler is now fixed (see `app/api/settings/shopware/webhook/route.ts`),
 * but the bad registration already exists in Shop-Ware and the `shops`
 * document. This script:
 *   1. Lists current webhooks for the configured Shop-Ware credentials.
 *   2. Deletes any pointing at 0.0.0.0 / localhost / 127.0.0.1.
 *   3. Registers the canonical public URL (default https://mos.tools/api/webhooks/shopware,
 *      override with PUBLIC_WEBHOOK_URL env var).
 *   4. Updates the `shops.shopware.webhook` doc for shop 136.
 *
 * Must run in an environment with PRODUCTION Shop-Ware credentials
 * (SHOPWARE_PARTNER_API_ID / SHOPWARE_API_SECRET, and SHOPWARE_USE_SANDBOX
 * unset or "false") and a Mongo connection to the prod cluster.
 *
 * Usage:
 *   npx tsx scripts/reregister-state-street-shopware-webhook.ts           # dry run
 *   npx tsx scripts/reregister-state-street-shopware-webhook.ts --apply   # mutate
 */

import { getDb } from "@/lib/mongo";
import { shopWareRequest } from "@/lib/integrations/shopware/client";

const APPLY = process.argv.includes("--apply");
const PUBLIC_URL =
  process.env.PUBLIC_WEBHOOK_URL ||
  `${(process.env.NEXT_PUBLIC_BASE_URL || process.env.APP_BASE_URL || "https://mos.tools").replace(/\/$/, "")}/api/webhooks/shopware`;

const SW_EVENTS = [
  "repair_order.created",
  "repair_order.updated",
  "repair_order.deleted",
  "vehicle.updated",
  "customer.updated",
];

const MOS_SHOP_ID = 136;

async function main() {
  if (process.env.SHOPWARE_USE_SANDBOX === "true") {
    throw new Error(
      "Refusing to run with SHOPWARE_USE_SANDBOX=true — this script targets the production Shop-Ware tenant for State Street."
    );
  }
  if (!PUBLIC_URL.startsWith("https://") || /0\.0\.0\.0|localhost|127\.0\.0\.1/.test(PUBLIC_URL)) {
    throw new Error(`Refusing: bad PUBLIC_URL ${PUBLIC_URL}`);
  }

  console.log(`[Task #456] Target public URL: ${PUBLIC_URL}`);
  console.log(`[Task #456] Mode: ${APPLY ? "APPLY (will mutate)" : "DRY RUN"}`);

  const live = await shopWareRequest<any[]>("/webhooks");
  console.log(`[Task #456] Live webhooks (${live.length}):`);
  for (const w of live) console.log(`  - id=${w.id} url=${w.url}`);

  const stale = live.filter(
    (w) =>
      typeof w.url === "string" &&
      /(^|\/\/)(0\.0\.0\.0|localhost|127\.0\.0\.1)([:/]|$)/.test(w.url)
  );
  console.log(`[Task #456] Stale (bad-host) webhooks: ${stale.length}`);
  for (const w of stale) console.log(`  - DELETE id=${w.id} url=${w.url}`);

  const alreadyGood = live.find((w) => w.url === PUBLIC_URL);
  if (alreadyGood) {
    console.log(`[Task #456] Good URL already registered: id=${alreadyGood.id}`);
  } else {
    console.log(`[Task #456] Will register new webhook → ${PUBLIC_URL}`);
  }

  if (!APPLY) {
    console.log("[Task #456] Dry run complete — re-run with --apply to mutate.");
    return;
  }

  for (const w of stale) {
    try {
      await shopWareRequest(`/webhooks/${w.id}`, { method: "DELETE" });
      console.log(`[Task #456] Deleted webhook ${w.id}`);
    } catch (err: any) {
      if (err.message?.includes("404")) {
        console.warn(`[Task #456] Webhook ${w.id} already gone (404), continuing`);
      } else {
        throw err;
      }
    }
  }

  let created: any = alreadyGood;
  if (!created) {
    created = await shopWareRequest("/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: PUBLIC_URL, events: SW_EVENTS }),
    });
    console.log(`[Task #456] Registered new webhook id=${created.id} url=${created.url}`);
  }

  const db = await getDb();
  const res = await db.collection("shops").updateOne(
    { shopId: { $in: [MOS_SHOP_ID, String(MOS_SHOP_ID)] } },
    {
      $set: {
        "shopware.webhook.webhookId": String(created.id),
        "shopware.webhook.webhookUrl": created.url ?? PUBLIC_URL,
        "shopware.webhook.events": created.events ?? SW_EVENTS,
        "shopware.webhook.registeredAt": new Date(),
      },
    }
  );
  console.log(`[Task #456] Mongo update: matched=${res.matchedCount} modified=${res.modifiedCount}`);

  const after = await shopWareRequest<any[]>("/webhooks");
  console.log("[Task #456] Final webhook list:");
  for (const w of after) console.log(`  - id=${w.id} url=${w.url}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Task #456] FAILED:", err);
    process.exit(1);
  });
