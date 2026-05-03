/**
 * Task #300 backfill: populate `mosShopId` on Mongo `concern_conversations`
 * (and `concern_question_stats`) docs that still only have the legacy raw
 * provider `shopId`.
 *
 * Resolution: for every distinct legacy `shopId` value, look up the
 * canonical mosShopId via the `shops` collection (matches the runtime
 * guard's resolution path), then `updateMany` the docs sharing that
 * legacy ID.
 *
 * Idempotent: only touches docs missing `mosShopId`. Safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/backfill-concern-conversations-mos-shop-id.ts          # apply
 *   npx tsx scripts/backfill-concern-conversations-mos-shop-id.ts --dry-run
 */

import { getDb } from "@/lib/mongo";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";

async function backfillCollection(
  collName: string,
  dryRun: boolean,
): Promise<void> {
  const db = await getDb();
  const col = db.collection(collName);

  const distinct: any[] = await col.distinct("shopId", {
    mosShopId: { $exists: false },
    shopId: { $ne: null, $exists: true },
  });

  console.log(`[${collName}] ${distinct.length} distinct legacy shopId values with no mosShopId`);

  let resolved = 0;
  let unresolved = 0;
  let updated = 0;

  for (const raw of distinct) {
    if (raw == null || raw === "") {
      unresolved += 1;
      continue;
    }
    const result = await findShopBySmsId(String(raw), { isPlatformAdmin: true });
    if (!result) {
      console.warn(`[${collName}] could not resolve shopId="${raw}" — skipping`);
      unresolved += 1;
      continue;
    }
    resolved += 1;
    if (dryRun) {
      const n = await col.countDocuments({
        shopId: raw,
        mosShopId: { $exists: false },
      });
      console.log(`[${collName}][dry-run] would set mosShopId=${result.mosShopId} on ${n} doc(s) for shopId="${raw}"`);
      continue;
    }
    const res = await col.updateMany(
      { shopId: raw, mosShopId: { $exists: false } },
      { $set: { mosShopId: Number(result.mosShopId) } },
    );
    updated += res.modifiedCount;
    console.log(`[${collName}] shopId="${raw}" → mosShopId=${result.mosShopId} (${res.modifiedCount} doc(s))`);
  }

  console.log(`[${collName}] done. resolved=${resolved} unresolved=${unresolved} docsUpdated=${updated}${dryRun ? " (dry-run)" : ""}`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await backfillCollection("concern_conversations", dryRun);
  await backfillCollection("concern_question_stats", dryRun);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
