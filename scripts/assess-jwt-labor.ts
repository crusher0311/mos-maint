/**
 * Read-only, bounded pilot assessment. Never calls a provider or repairs data.
 * Uses the app's canonical enterprise membership, and explicitly targets the
 * external production PG connection (not the workspace database).
 */
import postgres from "postgres";
import { getDb, getMongoClient } from "../lib/mongo";

async function main() {
  const mongo = await getDb();
  const enterprises = await mongo.collection("enterprise_accounts").find(
    { name: /jim whaley|^jwt\b/i },
    { projection: { name: 1, shopIds: 1 }, maxTimeMS: 5000 },
  ).limit(3).toArray();
  if (enterprises.length !== 1) throw new Error("JWT membership did not resolve uniquely");
  const enterprise = enterprises[0];
  const ids = [...new Set((enterprise.shopIds || []).map(Number))] as number[];
  if (!ids.length || ids.length > 50 || ids.some(id => !Number.isSafeInteger(id) || id <= 0))
    throw new Error("Invalid or excessive membership");
  const shops = await mongo.collection("shops").find(
    { shopId: { $in: [...ids, ...ids.map(String)] } },
    { projection: { shopId: 1, name: 1, integrationProvider: 1, timezone: 1 }, maxTimeMS: 5000 },
  ).limit(100).toArray();
  console.log(JSON.stringify({ enterprise: { id: String(enterprise._id), name: enterprise.name, shopIds: ids }, shops }));
  if (!process.env.SUPABASE_PROD_DATABASE_URL) throw new Error("Production PG connection unavailable");
  const pg = postgres(process.env.SUPABASE_PROD_DATABASE_URL, {
    max: 1, connect_timeout: 10,
    connection: { options: "-c default_transaction_read_only=on -c statement_timeout=10000" },
  });
  try {
    for (const shopId of ids) {
      for (let month = 1; month <= 10; month++) {
      const start = `2026-${String(month).padStart(2,"0")}-01`;
      const end = month === 10 ? "2026-10-06" : `2026-${String(month+1).padStart(2,"0")}-01`;
      try {
      const rows = await pg.unsafe(`
        WITH orders AS MATERIALIZED (
          SELECT id, shop_id, status, coalesce(closed_date,completed_date) basis,
            provenance->>'sourceSystem' provider
          FROM normalized_work_orders
          WHERE shop_id=$1 AND coalesce(closed_date,completed_date)
            >= $2 AND coalesce(closed_date,completed_date) < $3
            AND status IN ('closed','invoiced','paid')
            AND NOT coalesce((soft_delete->>'isDeleted')::boolean,false)
        ), jobs AS (
          SELECT j.work_order_id, count(*) jobs,
            count(*) FILTER (WHERE labor_hours_billed IS NOT NULL) billed,
            count(*) FILTER (WHERE labor_hours_billed=0) zero_hours,
            count(*) FILTER (WHERE j.status IN ('declined','deferred')) declined,
            count(*) FILTER (WHERE discount_total<>0) discounts
          FROM normalized_service_jobs j JOIN orders o ON o.id=j.work_order_id AND o.shop_id=j.shop_id
          WHERE NOT coalesce((j.soft_delete->>'isDeleted')::boolean,false)
          GROUP BY j.work_order_id
        )
        SELECT to_char(basis,'YYYY-MM') AS month_key, provider, count(*) orders,
          count(*) FILTER (WHERE jobs IS NULL) orders_without_jobs,
          sum(jobs) jobs, sum(billed) jobs_with_billed_hours,
          sum(zero_hours) explicit_zero_job_hours, sum(declined) declined_jobs,
          sum(discounts) jobs_with_discount
        FROM orders LEFT JOIN jobs ON jobs.work_order_id=orders.id
        GROUP BY 1,2 ORDER BY 1,2`, [shopId, start, end]);
      console.log(JSON.stringify({ shopId, month: start.slice(0,7), months: rows }));
      } catch { console.log(JSON.stringify({ shopId, month: start.slice(0,7), unavailable: "statement deadline or database error" })); }
      }
    }
  } finally {
    await pg.end();
    await (await getMongoClient()).close();
  }
}
main().catch(error => { console.error(error.message); process.exit(1); });
