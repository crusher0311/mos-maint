import { getDb } from "../lib/db/drizzle";

async function main() {
  const db = getDb();
  const res: any = await db.execute(`
    SELECT pid, state, now() - query_start AS runtime, left(query, 200) AS q
    FROM pg_stat_activity
    WHERE query ILIKE '%normalized_service_jobs%' AND pid <> pg_backend_pid()
    ORDER BY query_start
  ` as any);
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  for (const r of rows) {
    console.log(`pid=${r.pid} state=${r.state} runtime=${r.runtime} q=${String(r.q).replace(/\s+/g, " ")}`);
  }
  if (rows.length === 0) console.log("no active normalized_service_jobs queries");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
