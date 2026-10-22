import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import postgres from "postgres";
import {beginBuild,appendBatch,publishBuild,report,type Manifest} from "../scripts/reporting-projection/model";

async function main(){
  const host=process.argv[2];
  assert.ok(host.startsWith("/tmp/reporting-projection."));
  const sql=postgres({host,port:5432,database:"postgres",username:process.env.USER??process.env.LOGNAME??"runner",max:1});
  // The runner strips credentials and networking; only its disposable Unix socket is used.
  try{
    await sql.unsafe(readFileSync("scripts/reporting-projection/schema.sql","utf8"));
    const saved=JSON.parse(readFileSync("generated-artifacts/reporting-snapshots/archive96.wn5KHB/shop-227.json","utf8"));
    const fixture:Manifest={shopId:227,inventoryComplete:true,entries:saved.map((c:any)=>({
      ...c,clearance:"reviewed",copies:c.copies.map((copy:any,i:number)=>({...copy,ref:`local-fixture/${i}`})),
    }))};
    // Reviewed = hypothetical LOCAL test clearance, not real owner/financial approval.
    const from="2026-09-01T00:00:00Z",to="2026-11-01T00:00:00Z";
    assert.equal((await report(sql,[227],227,from,to)).status,"not_built");
    await assert.rejects(()=>report(sql,[228],227,from,to));
    await assert.rejects(()=>beginBuild(sql,{...fixture,entries:[fixture.entries[0],fixture.entries[0]]}));
    const id=await beginBuild(sql,fixture);
    await assert.rejects(()=>publishBuild(sql,id,fixture));
    await appendBatch(sql,id,fixture,0,5);
    assert.equal((await report(sql,[227],227,from,to)).status,"not_built");
    assert.equal(await appendBatch(sql,id,fixture,0,5),5,"Lost response retry must be idempotent");
    // Restart means a fresh function invocation using only the durable checkpoint.
    const [progress]=await sql`SELECT checkpoint FROM invoice_projection.builds WHERE id=${id}`;
    await appendBatch(sql,id,fixture,progress.checkpoint,5);
    await publishBuild(sql,id,fixture);
    const complete=await report(sql,[227],227,from,to);
    assert.equal(complete.invoices,10);assert.equal(complete.covered,10);assert.equal(complete.unresolved,0);
    assert.ok(Math.abs(complete.averageSold-0.57)<1e-9);
    assert.ok(Math.abs(complete.averagePresented-1.642)<1e-9);
    console.log("PASS: retained ten-invoice cohort → PostgreSQL facts → report (hypothetical clearance only)");

    const changed=structuredClone(fixture);
    changed.entries[0].clearance="held";
    changed.entries[1].clearance="unknown";
    // Conflict between final retained copies, including a date outside the reporting interval.
    (changed.entries[2].copies[0].raw as any).InvoiceTime="2025-01-01T00:00:00";
    // Missing dates everywhere for a selected identity.
    changed.entries[3].copies.forEach(c=>{delete (c.raw as any).InvoiceTime;});
    const pending=await beginBuild(sql,changed);
    assert.equal((await report(sql,[227],227,from,to)).id,id);
    await appendBatch(sql,pending,changed,0,10);
    await assert.rejects(()=>appendBatch(sql,pending,fixture,0,10),"Source changes must invalidate replay");
    await publishBuild(sql,pending,changed);
    const incomplete=await report(sql,[227],227,from,to);
    assert.equal(incomplete.unresolved,4);assert.equal(incomplete.averageSold,null);
    assert.equal(incomplete.averagePresented,null);
    assert.equal((await report(sql,[227],227,"2026-10-19","2026-10-23")).unresolved,4,
      "Unknown dates must not disappear with a date filter");
    console.log("PASS: holds, missing clearance, conflicting dates and missing dates withhold averages");

    const interrupted=await beginBuild(sql,fixture);
    await sql.unsafe(`CREATE FUNCTION invoice_projection.fail_batch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.ordinal=3 THEN RAISE EXCEPTION 'injected interruption'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER interrupted BEFORE INSERT ON invoice_projection.facts FOR EACH ROW
      EXECUTE FUNCTION invoice_projection.fail_batch()`);
    await assert.rejects(()=>appendBatch(sql,interrupted,fixture,0,5));
    const [rolled]=await sql`SELECT checkpoint,(SELECT count(*) FROM invoice_projection.facts WHERE build_id=${interrupted}) AS n
      FROM invoice_projection.builds WHERE id=${interrupted}`;
    assert.equal(rolled.checkpoint,0);assert.equal(Number(rolled.n),0);
    assert.equal((await report(sql,[227],227,from,to)).id,pending);
    await sql.unsafe("DROP TRIGGER interrupted ON invoice_projection.facts");
    await appendBatch(sql,interrupted,fixture,0,10);
    await publishBuild(sql,interrupted,fixture);
    const [refs]=await sql`SELECT count(*) AS n FROM invoice_projection.evidence WHERE build_id=${interrupted}`;
    assert.equal(Number(refs.n),47);
    const unfinished={...fixture,inventoryComplete:false};
    const unfinishedId=await beginBuild(sql,unfinished);
    await appendBatch(sql,unfinishedId,unfinished,0,10);
    await assert.rejects(()=>publishBuild(sql,unfinishedId,unfinished));
    assert.equal((await report(sql,[227],227,from,to)).id,interrupted);
    console.log("PASS: interrupted batch rolls back, restart succeeds, source references retained, incomplete inventory cannot publish");
    // No fixture clearances: actual retained cohort must remain unavailable.
    const actual={...fixture,entries:fixture.entries.map(e=>({...e,clearance:"unknown" as const}))};
    const unreviewed=await beginBuild(sql,actual);await appendBatch(sql,unreviewed,actual,0,10);
    await publishBuild(sql,unreviewed,actual);
    assert.equal((await report(sql,[227],227,from,to)).unresolved,10);
    console.log("PASS: real cohort without fresh ownership/financial/hold clearance stays unresolved");
  }finally{await sql.end({timeout:2});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
