import test from "node:test";
import assert from "node:assert/strict";
import { dueDate, snapshotHash, validateSettings, type ExportConfig } from "../lib/protractor-exports/contract";
import { selectSnapshot, providerPayload } from "../lib/protractor-exports/sources";
import { destinationUrl, publicIPv4, resolveDestination, signature } from "../lib/protractor-exports/transport";
import { authorizeManager, authorizeShop } from "../lib/protractor-exports/authorization";
import { processShop } from "../lib/protractor-exports/engine";
import { retryExportState } from "../lib/protractor-exports/retry";
import { matchesAutoflowOutboxRow } from "./helpers/autoflow-outbox-fake";

function collection() {
  const rows: any[] = [];
  function update(row: any, u: any, inserted = false) {
    for (const [k,v] of Object.entries({ ...(inserted ? u.$setOnInsert : {}), ...u.$set })) {
      const p=k.split("."), leaf=p.pop()!; let target=row;
      for(const part of p) target=target[part]??={};
      target[leaf]=structuredClone(v);
    }
    for(const k of Object.keys(u.$unset??{})) delete row[k];
  }
  return { rows,
    async findOne(q:any) { return structuredClone(rows.find(r=>matchesAutoflowOutboxRow(r,q))??null); },
    async updateOne(q:any,u:any,o:any={}) {
      let row=rows.find(r=>matchesAutoflowOutboxRow(r,q)); const inserted=!row;
      if(!row&&!o.upsert)return {matchedCount:0};
      if(!row){row={_id:q._id};rows.push(row);}
      update(row,u,inserted);return {matchedCount:1};
    },
    async findOneAndUpdate(q:any,u:any) {
      const row=rows.find(r=>matchesAutoflowOutboxRow(r,q));if(!row)return null;
      update(row,u);return structuredClone(row);
    },
  };
}
function fixture(initialSnapshot=true) {
  const c={states:collection(),hashes:collection(),history:collection()};
  const config:ExportConfig={_id:"enterprise-a",revision:1,destination:"https://receiver.example/hook",
    shopIds:[1],timeZone:"America/Chicago",dailyTime:"02:00",initialSnapshot,paused:false,revoked:false,
    confirmedAt:"2026-01-01",approvedBy:"fixture",secret:"fixture"};
  let now=new Date("2026-10-19T12:00:00Z"), total=10, fail=false, unavailable=false, denied=false;
  const sent:any[]=[];
  const deps:any={collections:async()=>c,config:async()=>config,enabled:()=>true,
    now:()=>now,authorize:async()=>{if(denied)throw Error("shop_ownership_changed");},
    secret:()=>"fixture",
    source:async(_s:any,entity:any,after:any)=>{
      if(unavailable)throw Error("database with private data");
      if(entity==="work_order"||after)return {ids:[],snapshots:[],missing:0};
      return {ids:["old-invoice"],missing:0,snapshots:[{shopId:1,entityType:"invoice",
        providerId:"old-invoice",observedAt:now.toISOString(),source:"mongo.protractor_invoices",
        payload:{ID:"old-invoice",InvoiceDate:"2001-01-01",Total:total}}]};
    },
    send:async(_url:any,_secret:any,id:any,body:any)=>{sent.push({id,body});if(fail)throw Error("receiver_unavailable");},
  };
  return {c,config,deps,sent,step:()=>processShop(config,1,deps),advance:()=>now=new Date(+now+86400_000),
    fail:(v:boolean)=>fail=v,unavailable:(v:boolean)=>unavailable=v,deny:()=>denied=true,
    total:(v:number)=>total=v};
}
test("stable content hashing and deterministic mixed-store latest selection",()=>{
  const old={ID:"a",Total:1}, fresh={Total:2,ID:"a"};
  const selected=selectSnapshot(1,"invoice","a",[
    {id:"a",raw:old,at:"2026-01-01",source:"pg.protractor_invoices"},
    {id:"a",raw:fresh,at:"2026-02-01",source:"mongo.protractor_invoice_cache"},
  ])!;
  assert.equal(selected.payload.Total,2);
  assert.equal(snapshotHash(selected),snapshotHash({...selected,observedAt:"later",payload:{ID:"a",Total:2}}));
  assert.equal(providerPayload({ID:"a",apiKey:"never-export"}),null);
  assert.deepEqual(providerPayload({ID:"a",Inspection:{secret:"no"},Total:1}),{ID:"a",Total:1});
  assert.deepEqual(providerPayload({ID:"a",ServicePackages:[{ID:"job",
    InspectionLines:[{Result:"red",Notes:"private",Pictures:["private.jpg"]}],
    ServicePackageInspectionLines:[{Result:"red"}],LaborLines:[{Hours:1}],
  }]}),{ID:"a",ServicePackages:[{ID:"job",LaborLines:[{Hours:1}]}]});
});
test("exhausted collection failures resume the existing cursor and window through manual retry",async()=>{
  const f=fixture();await f.step();
  f.unavailable(true);
  for(let i=0;i<8;i++){f.advance();await f.step();}
  const state=f.c.states.rows[0], window=state.window, cursor=state.after, revision=state.revision;
  assert.equal(state.attempts,8);assert.equal(state.pending,undefined);
  f.unavailable(false);await f.step();assert.equal(state.attempts,8);
  assert.equal(await retryExportState(f.c.states,state._id),true);
  assert.equal(state.window,window);assert.equal(state.after,cursor);assert.equal(state.revision,revision);
  for(let i=0;i<5;i++)await f.step();
  assert.equal(state.completedWindow,window);
  assert.ok(f.sent.some(s=>JSON.parse(s.body).records.length===1));
});
test("DST dates, missing spring hour and repeated fall hour",()=>{
  assert.equal(dueDate(new Date("2026-03-08T08:01Z"),"America/Chicago","02:30"),"2026-03-08");
  assert.equal(dueDate(new Date("2026-11-01T06:45Z"),"America/Chicago","01:30"),"2026-11-01");
  assert.equal(dueDate(new Date("2026-11-01T07:45Z"),"America/Chicago","01:30"),"2026-11-01");
  assert.throws(()=>validateSettings({shopIds:[1]}));
});
test("destination rejects private, mapped, alternate-port, query, credentials and rebinding answers",async()=>{
  for(const ip of ["127.0.0.1","10.0.0.1","169.254.169.254","100.64.0.1","192.168.1.1","::ffff:127.0.0.1","198.18.0.1"])
    assert.equal(publicIPv4(ip),false);
  for(const u of ["http://receiver.example","https://user:pass@receiver.example","https://receiver.example:444",
    "https://127.0.0.1","https://receiver.example?token=x"])assert.throws(()=>destinationUrl(u));
  await assert.rejects(resolveDestination("https://receiver.example",async()=>["8.8.8.8","127.0.0.1"]));
  assert.equal(signature("key","1","id","body"),signature("key","1","id","body"));
});
test("initial snapshot, unchanged refetch and correction to an old invoice",async()=>{
  const f=fixture();for(let i=0;i<7;i++)await f.step();
  assert.equal(f.sent.filter(s=>JSON.parse(s.body).records.length).length,1);
  f.advance();for(let i=0;i<7;i++)await f.step();
  assert.equal(f.sent.filter(s=>JSON.parse(s.body).records.length).length,1);
  f.total(11);f.advance();for(let i=0;i<7;i++)await f.step();
  assert.equal(f.sent.filter(s=>JSON.parse(s.body).records.length).length,2);
  assert.equal(f.c.states.rows[0].baselineDone,true);
});
test("lost response retries immutable bytes/id across invocations; acknowledgment checkpoint recovery",async()=>{
  const f=fixture();await f.step();await f.step();f.fail(true);await f.step();
  const pending=structuredClone(f.c.states.rows[0].pending);
  assert.ok(pending);assert.equal(f.c.hashes.rows.length,0);
  f.advance();f.fail(false);await f.step();
  assert.deepEqual(f.sent[0],f.sent[1]);assert.equal(f.c.hashes.rows.length,1);
  assert.equal(f.c.states.rows[0].pending,undefined);
});
test("baseline without initial export; empty success is distinct from collection failure",async()=>{
  const f=fixture(false);for(let i=0;i<6;i++)await f.step();
  assert.equal(f.sent.length,1);assert.equal(JSON.parse(f.sent[0].body).kind,"window_complete");
  assert.equal(JSON.parse(f.sent[0].body).coverage.baselineOnly,true);
  f.advance();f.unavailable(true);await f.step();
  assert.equal(f.c.states.rows[0].failure,"collection_unavailable");
  assert.equal(f.sent.length,1);
});
test("pause, removed shop and revocation prevent pending sends",async()=>{
  for(const action of ["pause","remove","revoke"]){
    const f=fixture();await f.step();await f.step();
    if(action==="pause")f.config.paused=true;
    if(action==="revoke")f.config.revoked=true;
    if(action==="remove")f.deny();
    await f.step();assert.equal(f.sent.length,0);
  }
});
test("cross-enterprise, employee and removed membership denied; entitlements checked",async()=>{
  const deps:any={shop:async()=>({enterpriseId:"a",protractor:{connectionId:"fixture",apiKey:"fixture"}}),
    enterprises:async()=>[{id:"a",shopIds:[1]}],users:async()=>[{role:"admin",shopId:1}],
    entitlements:async()=>({effectiveFeatures:{maintenance:true}})};
  await assert.rejects(authorizeManager({role:"admin",shopId:1},"b",deps));
  await assert.rejects(authorizeManager({role:"employee",shopId:1},"a",deps));
  await authorizeShop("a",1,deps);
  await assert.rejects(authorizeShop("b",1,deps));
  deps.entitlements=async()=>({effectiveFeatures:{maintenance:false}});
  await assert.rejects(authorizeShop("a",1,deps));
});
test("accepted checkpoint resumes without duplicate send after storage failure",async()=>{
  const f=fixture();await f.step();await f.step();
  const real=f.c.hashes.updateOne;let first=true;
  f.c.hashes.updateOne=async(...args:any[])=>{if(first){first=false;throw Error("storage unavailable");}return (real as any)(...args);};
  await f.step();assert.ok(f.c.states.rows[0].pending.acceptedAt);
  f.advance();await f.step();
  assert.equal(f.sent.length,1);assert.equal(f.c.states.rows[0].pending,undefined);
});
test("size-limited partial pages preserve later records; oversize is explicit",async()=>{
  const f=fixture();let seen=false;
  f.deps.source=async(_s:any,entity:any,after:any)=>{
    if(entity==="work_order")return {ids:[],snapshots:[],missing:0};
    const all=["a","b","c"].filter(id=>id>after);
    return {ids:all,missing:0,snapshots:all.map(id=>({shopId:1,entityType:"invoice",providerId:id,
      observedAt:"2026-01-01",source:"fixture",payload:{ID:id,Notes:"x".repeat(id==="c"?600000:300000)}}))};
  };
  for(let i=0;i<12;i++)await f.step();
  const records=f.sent.flatMap(s=>JSON.parse(s.body).records);
  assert.deepEqual(records.map((r:any)=>r.providerId),["a","b"]);
  const complete=f.sent.map(s=>JSON.parse(s.body)).find(s=>s.kind==="window_complete");
  assert.equal(complete.coverage.oversized,1);assert.equal(complete.coverage.incomplete,true);
});
test("rate limit backs off, eight failures stop, expired lease resumes pending",async()=>{
  const f=fixture();await f.step();await f.step();
  let sends=0;f.deps.send=async()=>{sends++;throw Error("receiver_rate_limited");};
  await f.step();await f.step();assert.equal(sends,1);
  for(let i=0;i<10;i++){f.advance();await f.step();}
  assert.equal(sends,8);assert.equal(f.c.states.rows[0].failure,"receiver_rate_limited");
  f.c.states.rows[0].attempts=0;delete f.c.states.rows[0].retryAt;
  f.c.states.rows[0].lease="dead-worker";f.c.states.rows[0].leaseUntil=new Date("2000-01-01");
  f.deps.send=async()=>{sends++;};await f.step();assert.equal(sends,9);
});
