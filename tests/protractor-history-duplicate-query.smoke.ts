import assert from "node:assert/strict";
import postgres from "postgres";
import {readFileSync} from "node:fs";
import { HISTORY_EXISTING_INVOICE_SQL, historyFailureCode,requireHistoryIdentityIndex } from "../lib/protractor-history-existing-invoice";

async function main() {
  const port = Number(process.argv[2]);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const sql = postgres({ host: "127.0.0.1", port, database: "postgres",
    username: process.env.USER || "runner", max: 1 });
  try {
    assert.equal((await sql`select current_setting('invoice_preview.disposable',true) marker`)[0].marker,"yes");
    await sql`CREATE TABLE normalized_work_orders (id text, shop_id int, provenance jsonb)`;
    await assert.rejects(()=>requireHistoryIdentityIndex(sql));
    for(const statement of readFileSync("drizzle/0040_protractor_history_identity.sql","utf8").split("--> statement-breakpoint"))
      await sql.unsafe(statement);
    await requireHistoryIdentityIndex(sql);
    for(const flags of [{indisvalid:false},{indisready:false},{unfiltered:false},{indnatts:2}]){
      await assert.rejects(()=>requireHistoryIdentityIndex({unsafe:async()=>[{
        indisvalid:true,indisready:true,unfiltered:true,indnatts:1,amname:"gin",
        expression:"protractor_identity_keys_v1(provenance)",...flags}]}));
    }
    const id = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
    const mixed = "aBcDeFaB-AbCd-4aBc-8AbC-aBcDeFaBcDeF";
    const records = [
      ["same", 25, [{system:"protractor",idType:"legacy",idValue:mixed}]],
      ["other-shop", 29, [{system:"protractor",idValue:"11111111-1111-4111-8111-111111111111"}]],
      ["other-provider", 25, [{system:"tekmetric",idValue:"22222222-2222-4222-8222-222222222222"}]],
      ["missing", 25, []],
      ["null-id",25,[{system:"protractor",idValue:null}]],
    ] as const;
    for (const [key, shop, ids] of records)
      await sql`INSERT INTO normalized_work_orders VALUES (${key},${shop},${sql.json({sourceIds:ids})})`;
    assert.deepEqual((await sql.unsafe(HISTORY_EXISTING_INVOICE_SQL,[25,id])).map(r=>r.id),["same"]);
    assert.deepEqual((await sql.unsafe(HISTORY_EXISTING_INVOICE_SQL,[25,id.toUpperCase()])).map(r=>r.id),["same"]);
    assert.deepEqual((await sql.unsafe(HISTORY_EXISTING_INVOICE_SQL,[29,"11111111-1111-4111-8111-111111111111"])).map(r=>r.id),["other-shop"]);
    for (const missing of ["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"])
      assert.equal((await sql.unsafe(HISTORY_EXISTING_INVOICE_SQL,[25,missing])).length,0);
    assert.equal(historyFailureCode({code:"57014"}),"57014");
    assert.equal(historyFailureCode({code:"private payload",message:"secret"}),"UNCLASSIFIED");
    await sql`INSERT INTO normalized_work_orders SELECT 'noise-'||n,25,
      jsonb_build_object('sourceIds',jsonb_build_array(jsonb_build_object(
        'system','protractor','idType','legacy','idValue',md5(n::text))))
      FROM generate_series(1,120000) n`;
    await sql`CREATE INDEX nwo_shop_id_idx ON normalized_work_orders(shop_id)`;
    await sql`ANALYZE normalized_work_orders`;
    for(const needle of [id,"33333333-3333-4333-8333-333333333333"]){
      const result=await sql.unsafe("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+HISTORY_EXISTING_INVOICE_SQL,[25,needle]);
      const plan=result[0]["QUERY PLAN"][0];
      assert.ok(JSON.stringify(plan).includes("nwo_protractor_identity_keys_v1_idx"),"Planner must choose the identity index without forced settings");
      console.log(JSON.stringify({case:needle===id?"present":"absent",executionMs:plan["Execution Time"],rows:plan.Plan["Actual Rows"]}));
    }
    await assert.rejects(()=>sql`SELECT public.protractor_identity_keys_v1('{"sourceIds":42}'::jsonb)`);
    await sql`DROP INDEX nwo_protractor_identity_keys_v1_idx`;
    await sql`CREATE INDEX nwo_protractor_identity_keys_v1_idx ON normalized_work_orders(shop_id)`;
    await assert.rejects(()=>requireHistoryIdentityIndex(sql));
    console.log("PASS: indexed lookup preserves identity semantics; missing/wrong index and malformed identity containers fail closed");
  } finally { await sql.end(); }
}
main().catch(e=>{console.error(e);process.exitCode=1});
