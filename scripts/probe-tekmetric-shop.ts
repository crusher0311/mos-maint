// Reusable on-call helper: probe one or more Tekmetric shops to confirm
// they are reachable with the current credentials, and record the result
// on the `tekmetric_backfill_progress` row WITHOUT perturbing the cron's
// fair-queue ordering or the 6h auto-clear gate.
//
// Use this any time on-call needs to verify a stuck Tekmetric shop. The
// shared helpers in `lib/integrations/tekmetric/probe.ts` are the single
// safe place this pattern lives — they enforce the lastProbedAt /
// lastProbeOk / lastProbeError / lastProbeNote contract that prevents
// the regression task #46 fixed (see the REGRESSION GUARD comment in
// `probe.ts` and the matching pointer in
// `app/api/cron/tekmetric-backfill/route.ts`).
//
// Usage:
//   npx tsx scripts/probe-tekmetric-shop.ts <shopId> [<shopId> ...]
//   npx tsx scripts/probe-tekmetric-shop.ts 86,87,88
//
// Each shop id is the MOS `shopId` (not the Tekmetric numeric shop id);
// the script looks up the linked Tekmetric shop id from the `shops`
// collection.

import { getDb } from "../lib/mongo";
import {
  probeTekmetricShop,
  recordProbeResult,
} from "../lib/integrations/tekmetric/probe";

function parseShopIds(argv: string[]): number[] {
  const tokens = argv
    .slice(2)
    .flatMap(arg => arg.split(","))
    .map(s => s.trim())
    .filter(Boolean);

  const ids: number[] = [];
  for (const tok of tokens) {
    const n = Number(tok);
    if (!Number.isFinite(n)) {
      console.warn(`[probe] ignoring non-numeric shop id: ${tok}`);
      continue;
    }
    ids.push(n);
  }
  return ids;
}

async function main() {
  const shopIds = parseShopIds(process.argv);
  if (shopIds.length === 0) {
    console.error(
      "Usage: npx tsx scripts/probe-tekmetric-shop.ts <shopId> [<shopId> ...]\n" +
        "       npx tsx scripts/probe-tekmetric-shop.ts 86,87,88",
    );
    process.exit(2);
  }

  const db = await getDb();

  const shopDocs = await db
    .collection("shops")
    .find({ shopId: { $in: shopIds } })
    .toArray();
  const byId = new Map<number, any>();
  for (const s of shopDocs) byId.set(Number(s.shopId), s);

  const results: Array<Record<string, any>> = [];

  for (const shopId of shopIds) {
    const shop = byId.get(shopId);
    if (!shop) {
      results.push({ shopId, status: "skipped", reason: "shop document not found" });
      console.log(`[probe] shop=${shopId} SKIP — shop document not found`);
      continue;
    }

    const tekmetricShopId = shop.tekmetric?.shopId ?? shop.tekmetricShopId;
    if (!tekmetricShopId) {
      results.push({
        shopId,
        status: "skipped",
        reason: "shop has no Tekmetric link",
      });
      console.log(`[probe] shop=${shopId} SKIP — no Tekmetric link on shop document`);
      continue;
    }

    const probe = await probeTekmetricShop(Number(tekmetricShopId), shopId);
    await recordProbeResult(db, shopId, probe, { source: "probe-tekmetric-shop" });

    results.push({
      shopId,
      status: probe.ok ? "probed_ok" : "probed_failed",
      detail: probe.detail,
    });
    console.log(
      `[probe] shop=${shopId} ${probe.ok ? "PROBE_OK" : "PROBE_FAIL"} — ${probe.detail}`,
    );
  }

  console.log("\n" + "=".repeat(72));
  console.log("Per-shop results:");
  console.log("=".repeat(72));
  for (const r of results) console.log(JSON.stringify(r));

  process.exit(0);
}

main().catch(err => {
  console.error("probe-tekmetric-shop failed:", err);
  process.exit(1);
});
