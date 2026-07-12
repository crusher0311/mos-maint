import { getDb } from "../lib/db/drizzle";

async function main() {
  const db = getDb();
  const res: any = await db.execute(`
    SELECT
      count(*) FILTER (WHERE closed_date    < '1990-01-01') AS bad_closed,
      count(*) FILTER (WHERE completed_date < '1990-01-01') AS bad_completed,
      count(*) FILTER (WHERE check_in_date  < '1990-01-01') AS bad_checkin
    FROM normalized_work_orders
    WHERE provenance->>'sourceSystem' = 'protractor'
  ` as any);
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  console.log("work_orders:", JSON.stringify(rows[0]));

  const res2: any = await db.execute(`
    SELECT count(*) AS bad_sj_completed
    FROM normalized_service_jobs
    WHERE provenance->>'sourceSystem' = 'protractor'
      AND completed_at < '1990-01-01'
  ` as any);
  const rows2 = Array.isArray(res2) ? res2 : (res2.rows ?? []);
  console.log("service_jobs:", JSON.stringify(rows2[0]));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
