import postgres from "postgres";
const sql = postgres(process.env.SUPABASE_PROD_DATABASE_URL!, { max: 1, prepare: false });
await sql`SET statement_timeout = '120s'`;
const rows = await sql`
  SELECT date_trunc('hour', dt) AS h,
    count(*) FILTER (WHERE (substring(message from '"responseTimeMS":([0-9]+)'))::int > 30000) AS slow30s,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY (substring(message from '"responseTimeMS":([0-9]+)'))::int) AS p95
  FROM production_logs
  WHERE host = 'mos-maintenance-mvp-main' AND dt > '2026-08-04 00:00:00' AND message LIKE '{"clientIP"%'
  GROUP BY 1 ORDER BY 1`;
console.log(rows.map(r => `${r.h.toISOString().slice(5,13)}h slow>30s=${r.slow30s} p95=${Math.round(r.p95)}`).join("\n"));
await sql.end();
