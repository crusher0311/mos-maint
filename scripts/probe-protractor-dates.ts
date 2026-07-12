/**
 * Read-only probe: verify Protractor normalized history carries REAL
 * business dates (closed/completed) rather than falling back to the
 * ingest date (created_at) in the Data Status coalesce.
 * Run: npx tsx scripts/probe-protractor-dates.ts
 */
import { sql } from "drizzle-orm";

async function main() {
  const { getDb: getPg } = await import("../lib/db/drizzle");
  const pg = getPg();

  const wo = await pg.execute(sql`
    SELECT shop_id,
           count(*)::int AS total,
           count(closed_date)::int AS with_closed,
           count(completed_date)::int AS with_completed,
           count(*) FILTER (WHERE closed_date IS NULL AND completed_date IS NULL)::int AS date_fallback_rows,
           min(coalesce(closed_date, completed_date))::date AS oldest_real,
           min(created_at)::date AS oldest_ingest,
           max(coalesce(closed_date, completed_date))::date AS newest_real
    FROM normalized_work_orders
    WHERE provenance->>'sourceSystem' = 'protractor'
    GROUP BY shop_id ORDER BY shop_id
  `);
  console.log("WORK ORDERS (protractor):");
  for (const r of wo.rows ?? wo) {
    console.log(JSON.stringify(r));
  }

  const sj = await pg.execute(sql`
    SELECT j.shop_id,
           count(*)::int AS total,
           count(j.completed_at)::int AS with_completed_at
    FROM normalized_service_jobs j
    JOIN normalized_work_orders w ON w.id = j.work_order_id
    WHERE w.provenance->>'sourceSystem' = 'protractor'
    GROUP BY j.shop_id ORDER BY j.shop_id
  `);
  console.log("\nSERVICE JOBS (protractor):");
  for (const r of sj.rows ?? sj) {
    console.log(JSON.stringify(r));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
