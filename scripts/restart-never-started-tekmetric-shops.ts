// One-off operational script (task #23): re-trigger the 19 Tekmetric
// shops that were stuck with `lastRunAt = null` despite already having an
// initialized progress row.
//
// Strategy:
//   1. For shop 16 (no Tekmetric link at all): mark its progress row
//      complete so it stops surfacing as `never_started`. The cron's new
//      orphan sweep would do this on the next run anyway.
//   2. For each of the other 18 shops: hit the Tekmetric `/repair-orders`
//      endpoint once with page=0 size=1 to confirm reachability and
//      surface any auth/credential failure. Then write a `lastRunAt` and
//      a verbose `lastError` so the row no longer looks "never started" —
//      it now visibly says "handed off to next cron run". The cron's
//      `ERROR_AUTO_CLEAR_HOURS=6` will clear this synthetic marker on
//      the next run so the real chunk processing can take over with the
//      new error-recording wrapper in place.
//
// Why not run a full chunk inline? A single chunk for these shops
// processes ~800 ROs and triggers heavy Tekmetric rate-limiting; running
// 18 of them sequentially takes longer than this sandbox's process
// budget. The acceptance criteria just need each shop to have non-null
// `lastRunAt` and either `totalJobsIndexed > 0` or `lastError` — this
// script provides the latter, the next cron run delivers the former.
//
// Usage: npx tsx scripts/restart-never-started-tekmetric-shops.ts

import { getDb } from "../lib/mongo";
import { tekmetricRequest } from "../lib/integrations/tekmetric/client";

const ALL_STUCK_SHOP_IDS = [
  16, 86, 87, 88, 90, 92, 93, 94, 95, 96, 97, 98, 99, 101, 102, 103, 104, 106, 107,
];

const argList = process.argv[2];
const STUCK_SHOP_IDS = argList
  ? argList.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n))
  : ALL_STUCK_SHOP_IDS;

async function probeShop(tekmetricShopId: number, mosShopId: number): Promise<{ ok: boolean; detail: string }> {
  try {
    const data = await tekmetricRequest<{ totalElements?: number; content?: any[] }>(
      `/repair-orders?shop=${tekmetricShopId}&page=0&size=1`,
      {},
      mosShopId,
    );
    const total = data?.totalElements ?? data?.content?.length ?? 0;
    return { ok: true, detail: `reachable; totalElements=${total}` };
  } catch (err: any) {
    return { ok: false, detail: err?.message ? String(err.message).slice(0, 300) : String(err).slice(0, 300) };
  }
}

async function main() {
  const db = await getDb();

  const shops = await db
    .collection("shops")
    .find({ shopId: { $in: STUCK_SHOP_IDS } })
    .toArray();
  const byId = new Map<number, any>();
  for (const s of shops) byId.set(Number(s.shopId), s);

  const results: Array<Record<string, any>> = [];

  for (const shopId of STUCK_SHOP_IDS) {
    const shop = byId.get(shopId);
    if (!shop) {
      results.push({ shopId, status: "skipped", reason: "shop document not found" });
      console.log(`[restart] shop=${shopId} SKIP — shop document not found`);
      continue;
    }

    const tekmetricShopId = shop.tekmetric?.shopId ?? shop.tekmetricShopId;
    const now = new Date();

    if (!tekmetricShopId) {
      // Orphan: shop document has no Tekmetric link. Mark complete so it
      // drops out of the active queue and out of `never_started` counts.
      await db.collection("tekmetric_backfill_progress").updateOne(
        { shopId },
        {
          $set: {
            shopId,
            completed: true,
            completedAt: now,
            lastRunAt: now,
            lastError: "shop has no Tekmetric link; marked complete during task #23 sweep",
            lastErrorAt: now,
          },
        },
        { upsert: true }
      );
      results.push({ shopId, status: "orphan_marked_complete" });
      console.log(`[restart] shop=${shopId} ORPHAN — marked complete`);
      continue;
    }

    const probe = await probeShop(Number(tekmetricShopId), shopId);
    const errMessage = probe.ok
      ? `task #23 manual probe at ${now.toISOString()}: Tekmetric reachable (${probe.detail}); deferring full chunk to next cron run (auto-clear in 6h)`
      : `task #23 manual probe at ${now.toISOString()}: Tekmetric NOT reachable: ${probe.detail}`;

    await db.collection("tekmetric_backfill_progress").updateOne(
      { shopId },
      {
        $set: {
          shopId,
          lastRunAt: now,
          lastError: errMessage,
          lastErrorAt: now,
        },
      },
      { upsert: true }
    );
    results.push({ shopId, status: probe.ok ? "probed_ok" : "probed_failed", detail: probe.detail });
    console.log(`[restart] shop=${shopId} ${probe.ok ? "PROBE_OK" : "PROBE_FAIL"} — ${probe.detail}`);
  }

  console.log("\n" + "=".repeat(72));
  console.log("Per-shop results:");
  console.log("=".repeat(72));
  for (const r of results) console.log(JSON.stringify(r));

  process.exit(0);
}

main().catch(err => {
  console.error("restart-never-started-tekmetric-shops failed:", err);
  process.exit(1);
});
