import postgres from "postgres";
const sql = postgres(process.env.SUPABASE_PROD_DATABASE_URL!, { max: 1, prepare: false });
await sql`SET statement_timeout = '90s'`;
const rows = await sql`
  SELECT date_trunc('minute', dt) AS m, count(*) AS slow5s
  FROM production_logs
  WHERE host = 'mos-maintenance-mvp-main' AND dt > now() - interval '60 minutes'
    AND message LIKE '{"clientIP"%'
    AND (substring(message from '"responseTimeMS":([0-9]+)'))::int > 5000
  GROUP BY 1 ORDER BY 1`;
console.log(rows.map(r => `${r.m.toISOString().slice(11,16)} slow>5s=${r.slow5s}`).join("\n"));
const cron = await sql`
  SELECT dt, message FROM production_logs
  WHERE host = 'mos-maintenance-mvp-main' AND dt > now() - interval '60 minutes'
    AND (message LIKE '%[Cron] ▶%' OR message LIKE '%[Cron] ✓%' OR message LIKE '%Backfill%chunk%' OR message LIKE '%roster%')
  ORDER BY dt LIMIT 60`;
console.log("--- cron ---");
console.log(cron.map(r => `${r.dt.toISOString().slice(11,19)} ${r.message.slice(0,140)}`).join("\n"));
await sql.end();
