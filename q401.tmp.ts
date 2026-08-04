import postgres from "postgres";
async function main() {
  const sql = postgres(process.env.SUPABASE_PROD_DATABASE_URL!, { max: 1, ssl: "require" });
  await sql.unsafe("SET statement_timeout = '480s'");
  const rows = await sql`
    SELECT date_trunc('hour', dt) AS hr, count(*) AS n
    FROM production_logs
    WHERE dt > now() - interval '24 hours'
      AND message LIKE '%plan-pregenerate%401%'
    GROUP BY 1 ORDER BY 1 DESC`;
  for (const r of rows) console.log("HR", String(r.hr), r.n);
  const sample = await sql`
    SELECT dt, left(message, 500) AS msg
    FROM production_logs
    WHERE dt > now() - interval '24 hours'
      AND message LIKE '%plan-pregenerate%401%'
    ORDER BY dt DESC LIMIT 3`;
  for (const s of sample) console.log(String(s.dt), s.msg);
  await sql.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
