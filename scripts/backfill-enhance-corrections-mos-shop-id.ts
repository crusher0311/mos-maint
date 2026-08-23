/**
 * Task #300 backfill: populate enhance_corrections.mos_shop_id from the
 * legacy raw provider shop_id column.
 *
 * MUST run BEFORE applying drizzle/0010_drop_enhance_corrections_legacy_shop_id.sql,
 * which drops the legacy shop_id column. The 0010 migration short-circuits
 * with a clear error if any row still has mos_shop_id IS NULL after this
 * script runs, so a missed backfill won't silently orphan history.
 *
 * Resolution strategy: for every distinct legacy `shop_id` value (a string
 * holding a Tekmetric/Protractor/AutoFlow/ShopWare upstream ID), look up the
 * canonical `mosShopId` via Mongo's `shops` collection (matches the resolution
 * the runtime guard performs at request time), then bulk-update every row
 * sharing that legacy ID.
 *
 * Idempotent: only touches rows where mos_shop_id IS NULL. Safe to re-run.
 *
 * Implementation note: the drizzle schema (lib/db/schema/enhance-corrections.ts)
 * no longer declares the legacy shop_id column — it's about to be dropped.
 * This script therefore uses raw SQL for both the read and the update so it
 * stays valid through the entire migration window (post-0009, pre-0010).
 *
 * Usage:
 *   npx tsx scripts/backfill-enhance-corrections-mos-shop-id.ts          # apply
 *   npx tsx scripts/backfill-enhance-corrections-mos-shop-id.ts --dry-run
 */

import { getDb as getPgDb } from "@/lib/db/drizzle";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { sql } from "drizzle-orm";

interface LegacyIdRow extends Record<string, unknown> {
  shopId: string;
  n: number;
}

interface UpdateResult {
  rowCount?: number | null;
  count?: number;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const db = getPgDb();

  const distinctResult = await db.execute<LegacyIdRow>(sql`
    SELECT shop_id::text AS "shopId", COUNT(*)::int AS n
      FROM enhance_corrections
     WHERE mos_shop_id IS NULL
       AND shop_id IS NOT NULL
     GROUP BY shop_id
     ORDER BY n DESC
  `);

  const legacyIds: LegacyIdRow[] = Array.isArray(distinctResult)
    ? (distinctResult as unknown as LegacyIdRow[])
    : ((distinctResult as { rows?: LegacyIdRow[] }).rows ?? []);

  console.log(
    `[backfill] ${legacyIds.length} distinct legacy shop_id value(s) with NULL mos_shop_id`,
  );

  let resolved = 0;
  let unresolved = 0;
  let updated = 0;

  for (const { shopId, n } of legacyIds) {
    const result = await findShopBySmsId(shopId, { isPlatformAdmin: true });
    if (!result) {
      console.warn(
        `[backfill] could not resolve legacy shop_id="${shopId}" (${n} rows) — skipping`,
      );
      unresolved += 1;
      continue;
    }
    resolved += 1;
    if (dryRun) {
      console.log(
        `[backfill][dry-run] would set mos_shop_id=${result.mosShopId} for legacy shop_id="${shopId}" (${n} rows)`,
      );
      continue;
    }
    const mosShopId = Number(result.mosShopId);
    const updateResult = await db.execute<never>(sql`
      UPDATE enhance_corrections
         SET mos_shop_id = ${mosShopId}
       WHERE shop_id = ${shopId}
         AND mos_shop_id IS NULL
    `);
    const r = updateResult as unknown as UpdateResult;
    const count = r.rowCount ?? r.count ?? n;
    updated += count;
    console.log(
      `[backfill] shop_id="${shopId}" → mos_shop_id=${result.mosShopId} (${count} rows)`,
    );
  }

  console.log(
    `[backfill] done. resolved=${resolved} unresolved=${unresolved} rowsUpdated=${updated}${dryRun ? " (dry-run)" : ""}`,
  );

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
