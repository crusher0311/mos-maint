import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import * as engine from "../lib/jwt-september-recovery";

const data=new Map<string,Map<string,any>>();
const get=(v:any,path:string)=>path.split(".").reduce((v,k)=>v?.[k],v);
function matches(v:any,q:any):boolean {
  return Object.entries(q).every(([k,x]:[string,any])=>{
    if(k==="$or")return x.some((a:any)=>matches(v,a));
    const value=get(v,k);
    if(x&&typeof x==="object"&&!(x instanceof Date))
      return Object.entries(x).every(([op,a]:[string,any])=>op==="$exists"?(value!==undefined)===a:
        op==="$lt"?value<a:op==="$ne"?value!==a:op==="$in"?a.includes(value):assert.fail(op));
    return value===x;
  });
}
function collection(name:string) {
  if(!data.has(name))data.set(name,new Map());
  const rows=data.get(name)!;
  function update(q:any,u:any,options:any={}) {
    let row=[...rows.values()].find(x=>matches(x,q)),inserted=false;
    if(!row&&options.upsert){row={_id:q._id};inserted=true;rows.set(row._id,row);}
    if(!row)return null;
    if(inserted)Object.assign(row,structuredClone(u.$setOnInsert??{}));
    Object.assign(row,structuredClone(u.$set??{}));
    for(const k of Object.keys(u.$unset??{}))delete row[k];
    for(const [k,v] of Object.entries(u.$addToSet??{})){row[k]??=[];if(!row[k].includes(v))row[k].push(v);}
    return structuredClone(row);
  }
  return {
    findOne:async(q:any)=>structuredClone([...rows.values()].find(x=>matches(x,q))??null),
    findOneAndUpdate:async(q:any,u:any,o:any)=>update(q,u,o),
    updateOne:async(q:any,u:any,o:any)=>({matchedCount:update(q,u,o)?1:0}),
    deleteMany:async(q:any)=>{for(const [k,v]of rows)if(matches(v,q))rows.delete(k);},
  };
}
const mod={exports:{} as any};let token=0;
runInNewContext(ts.transpileModule(readFileSync("lib/data/repositories/jwt-september-recovery.ts","utf8"),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText,{exports:mod.exports,module:mod,Date,setInterval,clearInterval,
  require:(id:string)=>id==="node:crypto"?{randomUUID:()=>String(++token)}:
    id==="@/lib/mongo"?{getDb:async()=>({collection})}:
    id==="@/lib/jwt-september-recovery"?engine:assert.fail(id)});
const store=mod.exports;
async function main(){
  const n=engine.recoveryCandidates[0];
  assert.equal((await store.recoveryStatus()).status,"idle");
  await store.recoveryControl("start");
  const raw={ID:"source-a",WorkOrderNumber:n.wo,InvoiceNumber:n.invoice};
  let writes=0,release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;});
  const recover=async()=>{writes++;entered();await new Promise<void>(r=>{release=r;});return {outcomes:[{wo:n.wo,state:"applied"}]};};
  await store.recoveryStep(async()=>[raw],recover);
  for(let day=3;day<=30;day++) await store.recoveryStep(async()=>[],recover);
  const active=store.recoveryStep(async()=>assert.fail("must not fetch during repair"),recover);
  await ready;
  assert.equal((await store.recoveryStep(async()=>[],recover)).busy,true,"only one lease holder");
  await store.recoveryControl("pause");
  release();await active;
  assert.equal(writes,1);assert.equal((await store.recoveryStatus()).status,"paused");
  assert.equal((await store.recoveryStep(async()=>[],recover)).busy,true);
  assert.equal(writes,1,"pause never begins another write");
  assert.ok(!data.get("operator_invoice_recovery_sources")!.has(`${engine.JWT_RECOVERY_ID}:${n.wo}`));
  assert.ok(!JSON.stringify(await store.recoveryStatus()).includes("source-a"),"private raw payload not exposed");
  await store.recoveryControl("start");
  await store.recoveryStep(async()=>assert.fail(),async()=>{throw new Error("unexpected write");});
  assert.equal(writes,1,"resume does not replay committed invoice");
  data.clear();
  await store.recoveryControl("start");
  await store.recoveryStep(async()=>{throw new Error("policy denied");},recover);
  assert.equal((await store.recoveryStatus()).status,"paused");
  assert.equal(data.get("operator_invoice_recovery_jobs")!.get(engine.JWT_RECOVERY_ID).state.offset,0);
  await store.recoveryControl("start");
  await store.recoveryStep(async()=>{throw Object.assign(new Error(),{recoveryCode:"source_too_large"});},recover);
  assert.match((await store.recoveryStatus()).error,/single day's invoice response exceeds/);
  console.log("JWT durable lease, pause race, source privacy, cleanup, resume and failure checkpoints: PASS");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
