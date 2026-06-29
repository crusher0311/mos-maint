import postgres from "postgres";
async function main() {
  const sql = postgres(process.env.SUPABASE_PROD_DATABASE_URL!, { ssl: "require", max: 1 });
  try {
    console.log("=== smart-timing by host / appname / mode (last 10d) ===");
    const byHost = await sql`
      SELECT coalesce(host,'?') AS host, coalesce(appname,'?') AS appname,
             CASE WHEN message ILIKE '%[observe]%' THEN 'observe'
                  WHEN message ILIKE '%[enforce]%' THEN 'enforce'
                  WHEN message ILIKE '%[off]%' THEN 'off' ELSE 'other' END AS mode,
             count(*)::int AS n, min(dt) AS first, max(dt) AS last
      FROM production_logs
      WHERE message LIKE '%smart-timing%' AND dt > now() - interval '10 days'
      GROUP BY 1,2,3 ORDER BY mode, n DESC`;
    for (const r of byHost)
      console.log(`  host=${r.host} appname=${r.appname} mode=${r.mode} n=${r.n} first=${new Date(r.first).toISOString()} last=${new Date(r.last).toISOString()}`);

    console.log("\n=== canary scoping: not-in-canary suffix presence (enforce lines) ===");
    const canary = await sql`
      SELECT (message ILIKE '%not-in-canary%') AS not_in_canary, count(*)::int AS n
      FROM production_logs
      WHERE message LIKE '%smart-timing%' AND message ILIKE '%[enforce]%'
        AND dt > now() - interval '10 days' GROUP BY 1`;
    for (const r of canary) console.log(`  not_in_canary=${r.not_in_canary} n=${r.n}`);

    console.log("\n=== when did enforce first appear? ===");
    const firstEnf = await sql`
      SELECT min(dt) AS first, max(dt) AS last, count(*)::int AS n
      FROM production_logs WHERE message LIKE '%smart-timing%' AND message ILIKE '%[enforce]%'`;
    const f = firstEnf[0];
    console.log(`  enforce: first=${f.first?new Date(f.first).toISOString():'never'} last=${f.last?new Date(f.last).toISOString():'?'} total=${f.n}`);

    console.log("\n=== distinct shops actually BLOCKED (enforce, real skip, not 'not-in-canary') last 10d ===");
    const blocked = await sql`
      SELECT count(DISTINCT substring(message from 'shop=([0-9]+)'))::int AS shops
      FROM production_logs
      WHERE message LIKE '%smart-timing%' AND message ILIKE '%[enforce]%'
        AND message ILIKE '%BLOCK%' AND message NOT ILIKE '%not-in-canary%'
        AND dt > now() - interval '10 days'`;
    console.log(`  distinct shops enforce-blocked: ${blocked[0].shops}`);
  } finally { await sql.end(); }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message||e);process.exit(1);});
