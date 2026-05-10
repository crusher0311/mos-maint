/**
 * Task #414 cleanup: find rows in PG `normalized_service_jobs` (and
 * `normalized_line_items` / `normalized_payments` while we're here)
 * whose `work_order_id` does NOT exist in `normalized_work_orders`,
 * then either:
 *   1. Backfill the missing parent WO from Mongo (preferred), OR
 *   2. Soft-delete the orphan row when no Mongo source exists.
 *
 * Root cause is fixed in `lib/integrations/core/normalized-ingestion.ts`
 * (the `ingestWorkOrder` skip-path now upserts to PG idempotently). This
 * script repairs the orphan rows the bug already produced.
 *
 * Usage:
 *   npx tsx scripts/fix-orphan-pg-service-jobs.ts                 # dry run, all shops
 *   npx tsx scripts/fix-orphan-pg-service-jobs.ts --apply
 *   npx tsx scripts/fix-orphan-pg-service-jobs.ts --apply --shop=97
 */

import { sql } from "drizzle-orm";
import type { Document } from "mongodb";
import { getDb as getPgDb } from "../lib/db/drizzle";
import { getDb as getMongoDb } from "../lib/mongo";
import { SupabaseDualWriter } from "../lib/supabase-dual-writer";
import { NORMALIZED_COLLECTIONS } from "../lib/normalized-schema";

const APPLY = process.argv.includes("--apply");
const shopFlag = process.argv.find((a) => a.startsWith("--shop="));
const SHOP_ID = shopFlag ? Number(shopFlag.split("=")[1]) : null;

type OrphanTable =
  | "normalized_service_jobs"
  | "normalized_line_items"
  | "normalized_payments";

interface OrphanRow {
  id: string;
  work_order_id: string;
  shop_id: number;
  table: OrphanTable;
}

interface NormalizedWorkOrderMongoDoc extends Document {
  _id: string;
  shopId?: number;
}

async function findOrphans(table: OrphanTable): Promise<OrphanRow[]> {
  const db = getPgDb();
  const shopFilter = SHOP_ID ? sql`AND child.shop_id = ${SHOP_ID}` : sql``;
  // `sql.raw` is safe here — `table` is constrained to the local
  // `OrphanTable` union of fixed string literals.
  const tableIdent = sql.raw(table);
  const rows = (await db.execute(sql`
    SELECT child.id, child.work_order_id, child.shop_id
    FROM ${tableIdent} child
    LEFT JOIN normalized_work_orders wo ON wo.id = child.work_order_id
    WHERE wo.id IS NULL
      AND COALESCE((child.soft_delete->>'isDeleted')::boolean, false) = false
      ${shopFilter}
    ORDER BY child.shop_id, child.work_order_id
  `)) as unknown as Array<{
    id: string;
    work_order_id: string;
    shop_id: number | string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    work_order_id: r.work_order_id,
    shop_id: Number(r.shop_id),
    table,
  }));
}

async function softDeleteRow(row: OrphanRow): Promise<void> {
  const db = getPgDb();
  const tableIdent = sql.raw(row.table);
  await db.execute(sql`
    UPDATE ${tableIdent}
    SET soft_delete = jsonb_build_object(
      'isDeleted', true,
      'deletedAt', to_jsonb(now()),
      'deletedReason', 'task-414 orphan cleanup: parent work_order missing in PG'
    ),
    updated_at = now()
    WHERE id = ${row.id}
  `);
}

async function main() {
  console.log(`\n=== fix-orphan-pg-service-jobs (${APPLY ? "APPLY" : "DRY RUN"}) ===`);
  if (SHOP_ID) console.log(`scope: shop ${SHOP_ID} only`);

  const tables: OrphanTable[] = [
    "normalized_service_jobs",
    "normalized_line_items",
    "normalized_payments",
  ];

  const allOrphans: OrphanRow[] = [];
  for (const t of tables) {
    const rows = await findOrphans(t);
    console.log(`  ${t}: ${rows.length} orphan rows`);
    allOrphans.push(...rows);
  }

  if (allOrphans.length === 0) {
    console.log("\nNo orphans. Nothing to do.");
    return;
  }

  // Group orphans by shop_id + work_order_id so we only attempt one Mongo
  // backfill per missing WO.
  const missingWoByShop = new Map<number, Set<string>>();
  for (const o of allOrphans) {
    if (!missingWoByShop.has(o.shop_id)) missingWoByShop.set(o.shop_id, new Set());
    missingWoByShop.get(o.shop_id)!.add(o.work_order_id);
  }

  const mongoDb = await getMongoDb();
  const woCol = mongoDb.collection<NormalizedWorkOrderMongoDoc>(
    NORMALIZED_COLLECTIONS.workOrders,
  );
  const writer = new SupabaseDualWriter(getPgDb());

  let backfilled = 0;
  let softDeleted = 0;
  let stillMissing = 0;

  for (const [shopId, woIds] of missingWoByShop) {
    const ids = Array.from(woIds);
    console.log(`\n--- shop ${shopId}: ${ids.length} missing parent WO(s) ---`);
    const mongoDocs = await woCol.find({ _id: { $in: ids } }).toArray();
    const mongoById = new Map<string, NormalizedWorkOrderMongoDoc>(
      mongoDocs.map((d) => [String(d._id), d]),
    );

    for (const woId of ids) {
      const mongoDoc = mongoById.get(woId);
      if (mongoDoc) {
        if (APPLY) {
          try {
            await writer.upsertWorkOrder({ ...mongoDoc, shopId });
            backfilled += 1;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  WO ${woId}: backfill failed — ${msg}`);
            stillMissing += 1;
          }
        } else {
          backfilled += 1;
        }
      } else {
        // No Mongo source — soft-delete every child row that points at it.
        const orphansForWo = allOrphans.filter(
          (o) => o.shop_id === shopId && o.work_order_id === woId,
        );
        for (const o of orphansForWo) {
          if (APPLY) {
            try {
              await softDeleteRow(o);
              softDeleted += 1;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`  ${o.table} ${o.id}: soft-delete failed — ${msg}`);
            }
          } else {
            softDeleted += 1;
          }
        }
      }
    }
  }

  console.log(`\n=== summary ===`);
  console.log(`  parent WOs backfilled from Mongo: ${backfilled}`);
  console.log(`  child rows soft-deleted (no Mongo source): ${softDeleted}`);
  if (stillMissing) console.log(`  WOs still missing after backfill attempt: ${stillMissing}`);
  if (!APPLY) console.log(`\n(dry run — re-run with --apply to mutate)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
