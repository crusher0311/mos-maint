import postgres from "postgres";
import { LABOR_REPORT_SQL } from "../lib/labor-reporting-query";
import { aggregateLaborFacts, type LaborFact } from "../lib/labor-reporting-aggregate";
import { recoverLaborEvidence } from "../lib/labor-reporting-recovery";
import { getMongoClient } from "../lib/mongo";
import { laborPartitions } from "../lib/labor-reporting-partitions";
async function main() {
  const enterprise = process.argv.includes("--enterprise");
  const explain = process.argv.includes("--explain");
  const pg = postgres(process.env.SUPABASE_PROD_DATABASE_URL!, {
    max:1, connect_timeout:10,
    connection:{options:`-c default_transaction_read_only=on -c statement_timeout=${enterprise ? 45000 : 10000}`},
  });
  let recoveryStarted = false;
  try {
    const started = Date.now();
    const rows: any[] = [];
    for (const params of laborPartitions(enterprise ? [227,228,229,230,231,232,233,234,235,236] : [227],
      new Date(enterprise ? "2026-01-01T00:00:00Z" : "2026-09-01T00:00:00Z"),
      new Date(enterprise ? "2026-10-05T23:59:59.999Z" : "2026-09-30T23:59:59.999Z"))) {
      const remaining = started + 300000 - Date.now();
      if (remaining <= 0) throw new Error("Overall background report deadline exceeded");
      await pg.unsafe(`SET statement_timeout = ${Math.min(45000, remaining)}`);
      const batch = await pg.unsafe((explain ? "EXPLAIN " : "") + LABOR_REPORT_SQL, params);
      if (explain) { console.log(batch.map(r=>r["QUERY PLAN"]).join("\n")); return; }
      rows.push(...batch);
      console.log("partition", params[0], params[1].slice(0,7), "rows", batch.length, "elapsedMs", Date.now()-started);
      if (rows.length > 100000) throw new Error("Labor reporting row cap exceeded");
    }
    console.log("query duration ms", Date.now()-started);
    const facts = rows as unknown as LaborFact[];
    console.log("normalized", JSON.stringify(aggregateLaborFacts(facts).summary));
    recoveryStarted = true;
    console.log("cache matches", await recoverLaborEvidence(facts, Date.now()+8000));
    console.log("recovered", JSON.stringify(aggregateLaborFacts(facts).summary));
  } finally {
    await pg.end({ timeout: 5 });
    if (recoveryStarted) await (await getMongoClient()).close();
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
