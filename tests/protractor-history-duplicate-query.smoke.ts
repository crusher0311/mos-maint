import assert from "node:assert/strict";
import postgres from "postgres";
import { HISTORY_EXISTING_INVOICE_SQL, historyFailureCode } from "../lib/protractor-history-existing-invoice";

async function main() {
  const port = Number(process.argv[2]);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const sql = postgres({ host: "127.0.0.1", port, database: "postgres",
    username: process.env.USER || "runner", max: 1 });
  try {
    await sql`CREATE TEMP TABLE normalized_work_orders (id text, shop_id int, provenance jsonb)`;
    const id = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
    const mixed = "aBcDeFaB-AbCd-4aBc-8AbC-aBcDeFaBcDeF";
    const records = [
      ["same", 25, [{system:"protractor",idType:"legacy",idValue:mixed}]],
      ["other-shop", 29, [{system:"protractor",idValue:"11111111-1111-4111-8111-111111111111"}]],
      ["other-provider", 25, [{system:"tekmetric",idValue:"22222222-2222-4222-8222-222222222222"}]],
      ["missing", 25, []],
    ] as const;
    for (const [key, shop, ids] of records)
      await sql`INSERT INTO normalized_work_orders VALUES (${key},${shop},${JSON.stringify({sourceIds:ids})}::jsonb)`;
    assert.deepEqual((await sql.unsafe(HISTORY_EXISTING_INVOICE_SQL,[25,id])).map(r=>r.id),["same"]);
    for (const missing of ["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"])
      assert.equal((await sql.unsafe(HISTORY_EXISTING_INVOICE_SQL,[25,missing])).length,0);
    assert.equal(historyFailureCode({code:"57014"}),"57014");
    assert.equal(historyFailureCode({code:"private payload",message:"secret"}),"UNCLASSIFIED");
    console.log("PASS: materialized duplicate query preserves mixed-case, tenant, provider and absent-invoice semantics");
  } finally { await sql.end(); }
}
main().catch(e=>{console.error(e);process.exitCode=1});
