import postgres from "postgres";
const sql = postgres(process.env.SUPABASE_PROD_DATABASE_URL!, { max: 1, prepare: false });
await sql`SET statement_timeout = '90s'`;
const rows = await sql`
  SELECT date_trunc('minute', dt) AS m, count(*) AS reqs,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY (substring(message from '"responseTimeMS":([0-9]+)'))::int) AS p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY (substring(message from '"responseTimeMS":([0-9]+)'))::int) AS p95
  FROM production_logs
  WHERE host = 'mos-maintenance-mvp-main' AND dt > now() - interval '25 minutes' AND message LIKE '{"clientIP"%'
  GROUP BY 1 ORDER BY 1`;
console.log(rows.map(r => `${r.m.toISOString().slice(11,16)} reqs=${r.reqs} p50=${Math.round(r.p50)} p95=${Math.round(r.p95)}`).join("\n"));
const mx = await sql`SELECT max(dt) AS mx FROM production_logs WHERE host='mos-maintenance-mvp-main'`;
console.log("log freshness:", mx[0].mx?.toISOString());
await sql.end();
