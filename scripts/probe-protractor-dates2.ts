import { sql } from "drizzle-orm";
async function main() {
  const { getDb: getPg } = await import("../lib/db/drizzle");
  const pg = getPg();

  console.log("A) breakdown of NULL-date rows by type/status (protractor):");
  const a = await pg.execute(sql`
    SELECT work_order_type, status, count(*)::int AS n,
           count(check_in_date)::int AS with_checkin
    FROM normalized_work_orders
    WHERE provenance->>'sourceSystem' = 'protractor'
      AND closed_date IS NULL AND completed_date IS NULL
    GROUP BY 1,2 ORDER BY n DESC LIMIT 12
  `);
  for (const r of a) console.log(JSON.stringify(r));

  console.log("\nB) garbage ancient dates (< 1990):");
  const b = await pg.execute(sql`
    SELECT shop_id, count(*)::int AS n,
           min(coalesce(closed_date, completed_date))::date AS worst
    FROM normalized_work_orders
    WHERE provenance->>'sourceSystem' = 'protractor'
      AND coalesce(closed_date, completed_date) < '1990-01-01'
    GROUP BY shop_id ORDER BY n DESC
  `);
  for (const r of b) console.log(JSON.stringify(r));

  console.log("\nC) shop 143 sample of NULL-date rows:");
  const c = await pg.execute(sql`
    SELECT work_order_number, work_order_type, status,
           check_in_date::date, created_at::date
    FROM normalized_work_orders
    WHERE provenance->>'sourceSystem' = 'protractor'
      AND shop_id = 143 AND closed_date IS NULL AND completed_date IS NULL
    ORDER BY created_at DESC LIMIT 8
  `);
  for (const r of c) console.log(JSON.stringify(r));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
