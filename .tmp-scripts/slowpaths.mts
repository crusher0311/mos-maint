import postgres from "postgres";
const sql = postgres(process.env.SUPABASE_PROD_DATABASE_URL!, { max: 1, prepare: false });
await sql`SET statement_timeout = '90s'`;
const rows = await sql`
  SELECT substring(message from '"path":"([^"]+)"') AS path,
    count(*) AS n,
    max((substring(message from '"responseTimeMS":([0-9]+)'))::int) AS maxms
  FROM production_logs
  WHERE host = 'mos-maintenance-mvp-main' AND dt > now() - interval '45 minutes'
    AND message LIKE '{"clientIP"%'
    AND (substring(message from '"responseTimeMS":([0-9]+)'))::int > 5000
  GROUP BY 1 ORDER BY n DESC LIMIT 15`;
console.log(rows.map(r => `${r.n}x max=${Math.round(r.maxms/1000)}s ${r.path}`).join("\n") || "no requests over 5s");
await sql.end();
