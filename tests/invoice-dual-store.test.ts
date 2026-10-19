import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import net from "node:net";
import {spawnSync} from "node:child_process";
import {writeFileSync,readFileSync} from "node:fs";
import {LocalDualMetadataStore,DUAL_SCHEMA,dualIdentity} from "../scripts/invoice-metadata-dual-store";
import {evidenceDigest as digest,prepareInvoiceMetadataProposal} from "../scripts/invoice-metadata-repair-plan";
import {type CurrentCase,type FinalPlan,type Approval,type Readiness} from "../scripts/invoice-metadata-executor";
import {initializeReplica,replicaPorts,losePrimaryAtShadow,restartMember} from "./helpers/invoice-replica";
const socket=process.env.INVOICE_DUAL_SOCKET!,port=Number(process.env.INVOICE_DUAL_PORT),marker=process.env.INVOICE_DUAL_MARKER!;
const open=()=>new LocalDualMetadataStore(socket,port,marker,replicaPorts);
let store=open();
function fixture(explicitNull=false,n=1){
  const shop=9000+n,key=`fixture-row-${n}`,id=`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
  const raw={ID:id,Type:"Invoice",WorkflowStage:"Invoice",InvoiceNumber:1,
    InvoiceTime:"2026-10-16T12:00:00Z",ServicePackages:[],DeferredServicePackages:[]};
  const source={shopId:shop,sourceIds:[id],copies:[{shopId:shop,raw}]};
  const snapshot={id:createHash("sha256").update(`${shop}:${key}`).digest("hex"),shop_id:shop,
    status:"closed",soft_delete:{isDeleted:false},provenance:{sourceSystem:"protractor",
      sourceIds:[{system:"protractor",idType:"invoice_id",idValue:id}]},
    custom_fields:{unrelated:{preserve:[null,0,"value"]},...(explicitNull?{invoiceHours:null}:{})}};
  const owner={key,revision:10,snapshot,row:{...snapshot,id:key,grand_total:"125.00",raw_payload:raw}};
  const current:CurrentCase={canonical:[owner],shadow:[{...structuredClone(owner),key:n===1?"shadow":`shadow-${n}`}],
    source,holds:[],evidenceInventory:{archives:[digest(raw)],holdsRevision:1}};
  return {current,proposal:prepareInvoiceMetadataProposal(source,[snapshot])};
}
const approve=(plan:FinalPlan,action:Approval["action"]="apply"):Approval=>({
  action,planDigest:digest(plan),preflightDigest:digest({cases:plan.cases,readiness:plan.readiness,at:plan.preflightAt}),
  approvedBy:"fixture-only",approvalReference:"fixture-consent",approvedAt:Date.now(),expiresAt:plan.expiresAt,
});
async function seed(explicitNull=false,count=1){
  await store.sql.unsafe("TRUNCATE dual_context,dual_owners,dual_journal,dual_audit; UPDATE dual_fence SET operation=null");
  await store.db.collection("owners").deleteMany({});
  const fixtures=Array.from({length:count},(_,i)=>fixture(explicitNull,i+1));
  for(const f of fixtures){
  const {canonical,shadow,...context}=f.current;
  await store.sql`INSERT INTO dual_context VALUES(${dualIdentity(f.proposal)},${store.sql.json(context as any)})`;
  await store.sql`INSERT INTO dual_owners VALUES(${canonical[0].key},${dualIdentity(f.proposal)},${store.sql.json(canonical[0] as any)})`;
  await store.db.collection("owners").insertOne({_id:shadow[0].key as any,owner:shadow[0]});
  }
  const now=Date.now();
  const readiness:Readiness={topology:"disposable-pg-mongo",requiredWriterIds:["fixture"],
    writers:[{id:"fixture",deployedRevision:"local",runtimeRevision:"local",preservationVerified:true,
      rawRetentionVerified:true,invoiceEvidenceVersion:1,verificationDigest:digest("fixture")}],
    verifiedAt:now,writersQuiesced:true,quiescenceEvidenceDigest:digest("local-gate")};
  return store.finalize({proposals:fixtures.map(f=>f.proposal),held:[],repairAuthorized:false,livePreflightRequired:true},readiness);
}
async function main(){
  assert.equal(process.env.SUPABASE_PROD_DATABASE_URL,undefined);
  assert.equal(process.env.MONGODB_PASSWORD,undefined);
  assert.throws(()=>net.connect({host:"127.0.0.1",port:1}),/denied/);
  assert.throws(()=>net.connect({host:"127.0.0.2",port}),/denied/);
  assert.throws(()=>net.connect({host:"example.com",port}),/denied/);
  assert.throws(()=>net.connect({path:"/tmp/unapproved.sock"}),/denied/);
  await assert.rejects(fetch("https://example.com"),/denied/);
  await initializeReplica();
  await store.mongo.connect();
  await store.db.collection("marker").insertOne({_id:marker as any},{writeConcern:{w:"majority"}});
  await store.sql.unsafe(DUAL_SCHEMA);
  for(const explicitNull of [false,true]){
    let plan=await seed(explicitNull);
    await store.execute(plan,approve(plan));
    await store.execute(plan,approve(plan)); // Exact receipt retry.
    await store.execute(plan,approve(plan,"rollback"));
    await store.execute(plan,approve(plan,"rollback"));
    const outcome:any=await store.inspect(plan,0);
    for(const side of ["canonical","shadow"] as const){
      const expected=structuredClone(plan.cases[0][side][0]);expected.revision+=2;
      assert.deepEqual(outcome.current[side][0],expected);
    }
    await assert.rejects(store.execute(plan,approve(plan)),/changed|reapplied/);
  }
  for(const fault of ["canonical","shadow","finished"] as const){
    const plan=await seed(),approval=approve(plan);
    store.fault=fault;
    await assert.rejects(store.execute(plan,approval),/Injected/);
    if(fault!=="finished")await assert.rejects(store.guarded(async()=>true),/blocked/);
    // New clients: recovery uses persisted receipts, never in-memory flags.
    await store.close();store=open();
    await store.execute(plan,approval);
    const outcome:any=await store.inspect(plan,0);
    assert.equal(outcome.fenced,false);
    assert.ok(outcome.journal.some((j:any)=>j.phase==="completed"));
  }
  for(const fault of ["canonical","shadow","finished"] as const){
    const plan=await seed(true);
    await store.execute(plan,approve(plan));
    store.fault=fault;
    await assert.rejects(store.execute(plan,approve(plan,"rollback")),/Injected/);
    await store.close();store=open();
    await store.execute(plan,approve(plan,"rollback"));
    const result:any=await store.inspect(plan,0);
    assert.equal(result.current.shadow[0].row.custom_fields.invoiceHours,null);
    assert.equal(result.current.canonical[0].revision,12);
    assert.equal(result.fenced,false);
  }
  // Actual process exit after the shadow commits, with no client cleanup.
  {
    const plan=await seed(),approval=approve(plan);
    writeFileSync(`${socket}/crash.json`,JSON.stringify({plan,approval}),{mode:0o600});
    const child=spawnSync(process.execPath,["--import","tsx","tests/invoice-dual-store.test.ts","--crash"],
      {env:process.env,timeout:15000,encoding:"utf8"});
    assert.equal(child.status,86,child.stderr);
    await assert.rejects(store.guarded(async()=>true),/blocked/);
    await store.execute(plan,approval);
    assert.equal((await store.inspect(plan,0) as any).fenced,false);
  }
  let plan=await seed();store.fault="canonical";
  await assert.rejects(store.execute(plan,approve(plan)),/Injected/);store.fault=null;
  await assert.rejects(store.execute(plan,{...approve(plan),expiresAt:0}),/expired/);
  assert.equal((await store.inspect(plan,0) as any).fenced,true);
  // A shadow changed behind the guard must reject, not overwrite or unfence.
  await store.db.collection("owners").updateOne({_id:"shadow" as any},{$set:{"owner.row.grand_total":"999.00"}});
  await assert.rejects(store.execute(plan,approve(plan)),/changed/);
  await assert.rejects(store.guarded(async()=>true),/blocked/);
  plan=await seed();
  await store.sql`UPDATE dual_context SET value=jsonb_set(value,'{holds}','["financial-review"]')`;
  await assert.rejects(store.execute(plan,approve(plan)),/changed/);
  plan=await seed();
  await store.db.collection("owners").insertOne({_id:"competitor" as any,owner:plan.cases[0].shadow[0]});
  await assert.rejects(store.execute(plan,approve(plan)),/changed/);
  plan=await seed();
  await store.execute(plan,approve(plan));
  await store.db.collection("owners").updateOne({_id:"shadow" as any},{$unset:{receipt:""}});
  await assert.rejects(store.execute(plan,approve(plan)),/changed/);
  plan=await seed();
  const outcomes=await Promise.allSettled([store.execute(plan,approve(plan)),store.execute(plan,approve(plan))]);
  assert.ok(outcomes.some(o=>o.status==="fulfilled"));
  await store.execute(plan,approve(plan));
  assert.equal((await store.inspect(plan,0) as any).current.canonical[0].revision,11);
  plan=await seed(false,100);store.fault="canonical";store.faultIndex=1;
  await assert.rejects(store.execute(plan,approve(plan)),/Injected/);
  assert.equal((await store.inspect(plan,0) as any).journal[0].phase,"completed");
  assert.equal((await store.inspect(plan,2) as any).journal.length,0);
  store.fault=null;
  await store.execute(plan,approve(plan));
  assert.equal(Number((await store.sql`SELECT count(*) n FROM dual_journal WHERE phase='completed'`)[0].n),100);
  assert.equal((await store.inspect(plan,99) as any).current.shadow[0].revision,11);
  await replicaRecovery();
  console.log("PASS real PostgreSQL + three-member Mongo replica: CAS, receipts, SIGKILL/election, fence, expiry, drift, rollback, no partial report; no production access");
}
async function replicaRecovery(){
  for(const action of ["apply","rollback"] as const){
    for(const mode of ["before-cas","after-majority"] as const){
      const plan=await seed(true,3);
      if(action==="rollback")await store.execute(plan,approve(plan));
      const approval=approve(plan,action);
      const killed=await losePrimaryAtShadow(store,mode,()=>store.execute(plan,approval));
      await store.close();store=open();
      const state:any=await store.inspect(plan,1);
      assert.equal((await store.inspect(plan,0) as any).journal.find((j:any)=>j.id.endsWith(`:${action}`)).phase,"completed");
      assert.equal((await store.inspect(plan,2) as any).journal.filter((j:any)=>j.id.endsWith(`:${action}`)).length,0);
      assert.equal(state.fenced,true);
      assert.equal(state.journal.find((j:any)=>j.id.endsWith(`:${action}`)).phase,"canonical");
      assert.equal(state.current.canonical[0].revision,action==="apply"?11:12);
      assert.equal(state.current.shadow[0].revision,
        (action==="apply"?10:11)+(mode==="after-majority"?1:0));
      let emitted=false;
      await assert.rejects(store.guarded(async()=>{emitted=true;return "partial report";}),/blocked/);
      assert.equal(emitted,false);
      const before=digest(state);
      await assert.rejects(store.execute(plan,{...approval,expiresAt:0}),/expired/);
      assert.equal(digest(await store.inspect(plan,1)),before,"Expiry permits inspection, not replay");
      const shadowId="shadow-2" as any;
      const doc=await store.db.collection("owners").findOne({_id:shadowId});
      if(mode==="after-majority"){
        assert.ok(doc?.receipt);
        // Matching values do not prove ownership: both receipt fields are bound.
        for(const field of ["id","binding","missing"]){
          await store.db.collection("owners").updateOne({_id:shadowId},
            field==="missing"?{$unset:{receipt:""}}:{$set:{[`receipt.${field}`]:"wrong"}},
            {writeConcern:{w:"majority"}});
          await assert.rejects(store.execute(plan,approval),/changed/);
          assert.equal((await store.inspect(plan,0) as any).fenced,true);
          await store.db.collection("owners").updateOne({_id:shadowId},
            {$set:{receipt:doc!.receipt}},{writeConcern:{w:"majority"}});
        }
      }else if(action==="apply")assert.equal(doc?.receipt,undefined);
      if(action==="rollback"){
        await store.db.collection("owners").updateOne({_id:shadowId},
          {$set:{"owner.row.grand_total":"999.00"}},{writeConcern:{w:"majority"}});
        await assert.rejects(store.execute(plan,approval),/changed/);
        assert.equal((await store.inspect(plan,1) as any).current.shadow[0].row.grand_total,"999.00");
        await assert.rejects(store.guarded(async()=>true),/blocked/);
        // Test-only restoration, not an offered recovery operation.
        await store.db.collection("owners").replaceOne({_id:shadowId},doc!,{writeConcern:{w:"majority"}});
      }
      await store.execute(plan,approval);
      await store.execute(plan,approval);
      assert.equal((await store.inspect(plan,0) as any).fenced,false);
      for(let i=0;i<3;i++){
        const result:any=await store.inspect(plan,i);
        assert.equal(result.current.shadow[0].revision,action==="apply"?11:12);
        assert.equal(result.current.canonical[0].revision,action==="apply"?11:12);
      }
      await store.guarded(async()=>{emitted=true;});
      assert.equal(emitted,true);
      await restartMember(killed);
      console.log(`PASS replica ${action} ${mode}: elected survivor, fenced inspection, exact recovery`);
    }
  }
}
if(process.argv.includes("--crash")){
  const {plan,approval}=JSON.parse(readFileSync(`${socket}/crash.json`,"utf8"));
  store.fault="shadow";
  store.execute(plan,approval).then(()=>process.exit(1)).catch(error=>{
    if(String(error.message).includes("Injected"))process.exit(86);
    console.error(error);process.exit(2);
  });
}else main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>store.close());
