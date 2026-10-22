import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { PG_SOURCE_KEYS, pgSourceQuery } from "../lib/reporting-projection/source-query";

async function main() {
  const host = process.argv[2];
  assert.ok(host?.startsWith("/tmp/reporting-source."));
  const sql = postgres({host, port:5432, database:"postgres", max:1});
  try {
    assert.equal((await sql`SELECT current_setting('invoice_preview.disposable') AS marker`)[0].marker, "yes");
    const indexes = readFileSync("scripts/reporting-projection/source-indexes.sql","utf8")
      .split("\n").filter(l=>l.startsWith("CREATE INDEX")).map(l=>l.replace(" CONCURRENTLY",""));
    for (const [i, [table,key]] of Object.entries(PG_SOURCE_KEYS).entries()) {
      await sql.unsafe(`CREATE TABLE ${table}(shop_id int NOT NULL,${key} ${i<4?"varchar":"text"} NOT NULL,payload jsonb,
        PRIMARY KEY(shop_id,${key}))`);
      // 200k rows: 180k noisy neighbor, 19,990 target and 10 sparse-shop rows.
      await sql.unsafe(`INSERT INTO ${table} SELECT
        CASE WHEN n<=180000 THEN 1 WHEN n<=199990 THEN 227 ELSE 999 END,
        lpad(n::text,10,'0'),jsonb_build_object('rawPayload',repeat(md5(n::text),16))
        FROM generate_series(1,200000) n`);
      await sql.unsafe(indexes[i]);
      await sql.unsafe(`ANALYZE ${table}`);
      await sql.unsafe("SET statement_timeout='2s'");
      await sql.unsafe("SET plan_cache_mode='force_generic_plan'");
      for (const [shop,after,exact] of [
        [227,null,false],[227,"0000190000",false],[227,"0000199990",false],
        [227,"0000190000",true],[227,"does-not-exist",true],
        [999,null,false],[999,"0000199995",false],[444,null,false],
      ] as const) {
        const query = pgSourceQuery(table,after,exact);
        const params=[shop,after,16777216];
        // Use a real prepared statement: unsafe() alone is unprepared and would
        // not exercise force_generic_plan despite the session setting.
        await sql.unsafe(`PREPARE source_probe(int,text,int) AS ${query}`);
        const literal = after === null ? "NULL" : `'${after.replaceAll("'","''")}'`;
        const [plan] = await sql.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
          EXECUTE source_probe(${shop},${literal},16777216)`);
        await sql.unsafe("DEALLOCATE source_probe");
        const tree=plan["QUERY PLAN"][0];
        const nodes:any[]=[];
        const walk=(n:any)=>{nodes.push(n);(n.Plans??[]).forEach(walk);};
        walk(tree.Plan);
        assert.ok(!nodes.some(n=>["Seq Scan","Sort"].includes(n["Node Type"])),JSON.stringify(tree));
        assert.ok(tree.Plan["Shared Hit Blocks"]+tree.Plan["Shared Read Blocks"]<120,JSON.stringify(tree));
        assert.ok(tree["Execution Time"]<2000);
        const actual=await sql.unsafe(query,params);
        const expected=await sql.unsafe(`SELECT ${key}::text AS cursor,
          CASE WHEN octet_length(to_jsonb(t)::text)<=$3 THEN to_jsonb(t)::text END AS state
          FROM ${table} t WHERE shop_id=$1 AND ($2::text IS NULL OR ${key}::text COLLATE "C" ${exact?"=":">"} $2)
          ORDER BY ${key}::text COLLATE "C" LIMIT 1`,params);
        assert.deepEqual(actual,expected,"exact cursor and source bytes preserved");
        console.log(JSON.stringify({table,shop,mode:exact?"exact":after?"next":"first",
          milliseconds:tree["Execution Time"],buffers:tree.Plan["Shared Hit Blocks"]+tree.Plan["Shared Read Blocks"]}));
      }
      // Exact byte limit still rejects oversized source before transfer.
      const oversized=await sql.unsafe(pgSourceQuery(table,null,false),[227,null,10]);
      assert.equal(oversized[0].state,null);
      // Full traversal of mixed-case/non-ASCII keys across reconnect-like calls.
      for(const id of ["a","A","é","Z","10","2","ß"])
        await sql.unsafe(`INSERT INTO ${table} VALUES(555,$1,'{}')`,[id]);
      const seen:string[]=[];
      let cursor:string|null=null;
      for(;;){
        const rows: Array<{cursor:string}> = await sql.unsafe(pgSourceQuery(table,cursor,false),[555,cursor,16777216]);
        if(!rows.length)break;
        cursor=rows[0].cursor;seen.push(cursor!);
        assert.ok(seen.length<=7);
      }
      const expected=await sql.unsafe(`SELECT ${key} AS id FROM ${table} WHERE shop_id=555 ORDER BY ${key}::text COLLATE "C"`);
      assert.deepEqual(seen,expected.map(r=>r.id));
      await sql.unsafe("SET statement_timeout=0");
      await sql.unsafe(`DROP TABLE ${table}`);
    }
  } finally {await sql.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
