import postgres from "postgres";
const sql = postgres(process.env.SUPABASE_PROD_DATABASE_URL!, { max: 1, prepare: false });
await sql`SET statement_timeout = '60s'`;
const rows = await sql`
  SELECT date_trunc('minute', dt) AS m,
    count(*) FILTER (WHERE message LIKE '{"clientIP"%') AS reqs,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY (substring(message from '"responseTimeMS":([0-9]+)'))::int) AS p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY (substring(message from '"responseTimeMS":([0-9]+)'))::int) AS p95
  FROM production_logs
  WHERE host = 'mos-maintenance-mvp-main' AND dt > '2026-08-06 18:45:00' AND message LIKE '{"clientIP"%'
  GROUP BY 1 ORDER BY 1`;
console.log(rows.map(r => `${r.m.toISOString().slice(11,16)} reqs=${r.reqs} p50=${Math.round(r.p50)} p95=${Math.round(r.p95)}`).join("\n"));
const sm = await sql`
  SELECT dt, message FROM production_logs
  WHERE host = 'mos-maintenance-mvp-main' AND dt > '2026-08-06 18:45:00'
    AND (message LIKE '%Shopmonkey Backfill%' OR message LIKE '%shopmonkey-fullpage%')
  ORDER BY dt DESC LIMIT 15`;
console.log("--- SM lines ---");
console.log(sm.map(r => `${r.dt.toISOString().slice(11,19)} ${r.message.slice(0,200)}`).join("\n"));
const mx = await sql`SELECT max(dt) AS mx FROM production_logs WHERE host='mos-maintenance-mvp-main'`;
console.log("log freshness:", mx[0].mx?.toISOString());
await sql.end();
