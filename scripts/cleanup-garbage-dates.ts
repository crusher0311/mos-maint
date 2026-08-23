/**
 * One-off cleanup: NULL out remaining pre-1990 sentinel dates (.NET
 * DateTime.MinValue "0001-01-01") on Protractor normalized rows where the
 * raw payload has no real date either. NULL lets readers fall back cleanly
 * (coalesce) instead of displaying year 0001.
 *
 * Dry-run by default; pass --confirm to write.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}

async function main() {
  const live = process.argv.includes("--confirm");
  const url = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Missing database URL");
  const client = postgres(url, {
    max: 1,
    idle_timeout: 30,
    connect_timeout: 30,
    connection: { statement_timeout: 600000 },
  });
  const db = drizzle(client);

  const shopsRes: any = await db.execute(`
    SELECT DISTINCT shop_id FROM normalized_work_orders
    WHERE provenance->>'sourceSystem' = 'protractor'
    ORDER BY shop_id
  ` as any);
  const shopIds = rowsOf(shopsRes).map((r: any) => Number(r.shop_id));
  console.log(`[cleanup] mode=${live ? "LIVE" : "DRY RUN"} — ${shopIds.length} protractor shop(s)`);

  let woTotal = 0;
  let sjTotal = 0;
  for (const shopId of shopIds) {
    if (live) {
      const wo: any = await db.execute(`
        UPDATE normalized_work_orders
        SET closed_date    = CASE WHEN closed_date    < '1990-01-01' THEN NULL ELSE closed_date END,
            completed_date = CASE WHEN completed_date < '1990-01-01' THEN NULL ELSE completed_date END,
            check_in_date  = CASE WHEN check_in_date  < '1990-01-01' THEN NULL ELSE check_in_date END,
            updated_at = now()
        WHERE shop_id = ${shopId}
          AND provenance->>'sourceSystem' = 'protractor'
          AND (closed_date < '1990-01-01' OR completed_date < '1990-01-01' OR check_in_date < '1990-01-01')
      ` as any);
      const woN = Number(wo?.count ?? 0);
      const sj: any = await db.execute(`
        UPDATE normalized_service_jobs sj
        SET completed_at = NULL, updated_at = now()
        FROM normalized_work_orders wo
        WHERE wo.id = sj.work_order_id AND wo.shop_id = sj.shop_id
          AND wo.provenance->>'sourceSystem' = 'protractor'
          AND sj.shop_id = ${shopId} AND sj.completed_at < '1990-01-01'
      ` as any);
      const sjN = Number(sj?.count ?? 0);
      woTotal += woN;
      sjTotal += sjN;
      if (woN + sjN > 0) console.log(`  [cleanup] shop ${shopId}: WO rows=${woN} SJ rows=${sjN}`);
    } else {
      const wo: any = await db.execute(`
        SELECT count(*)::int AS n FROM normalized_work_orders
        WHERE shop_id = ${shopId}
          AND provenance->>'sourceSystem' = 'protractor'
          AND (closed_date < '1990-01-01' OR completed_date < '1990-01-01' OR check_in_date < '1990-01-01')
      ` as any);
      const sj: any = await db.execute(`
        SELECT count(*)::int AS n
        FROM normalized_service_jobs sj
        JOIN normalized_work_orders wo ON wo.id = sj.work_order_id AND wo.shop_id = sj.shop_id
        WHERE wo.provenance->>'sourceSystem' = 'protractor'
          AND sj.shop_id = ${shopId} AND sj.completed_at < '1990-01-01'
      ` as any);
      const woN = Number(rowsOf(wo)[0]?.n ?? 0);
      const sjN = Number(rowsOf(sj)[0]?.n ?? 0);
      woTotal += woN;
      sjTotal += sjN;
      if (woN + sjN > 0) console.log(`  [cleanup] shop ${shopId}: WO rows=${woN} SJ rows=${sjN}`);
    }
  }
  console.log(`[cleanup] DONE (${live ? "LIVE" : "DRY RUN"}) WO rows=${woTotal.toLocaleString()} SJ rows=${sjTotal.toLocaleString()}`);
  process.exit(0);
}

main().catch((e) => { console.error("[cleanup] FATAL", e); process.exit(1); });
