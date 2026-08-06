import postgres from "postgres";
const sql = postgres(process.env.SUPABASE_PROD_DATABASE_URL!, { max: 1, prepare: false });
await sql`SET statement_timeout = '110s'`;
for (const [a,b] of [["2026-08-05 00:00","2026-08-06 00:00"],["2026-08-06 00:00","2026-08-06 19:00"]]) {
  const rows = await sql`
    SELECT date_trunc('hour', dt) AS h, count(*) AS slow30s, min(dt) AS first
    FROM production_logs
    WHERE host = 'mos-maintenance-mvp-main' AND dt >= ${a} AND dt < ${b}
      AND message LIKE '{"clientIP"%'
      AND (substring(message from '"responseTimeMS":([0-9]+)'))::int > 30000
    GROUP BY 1 ORDER BY 1`;
  console.log(rows.map(r => `${r.h.toISOString().slice(5,13)}h slow>30s=${r.slow30s} first=${r.first.toISOString().slice(11,19)}`).join("\n") || `(${a}: none)`);
}
await sql.end();
