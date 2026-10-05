import assert from "node:assert/strict";
import {NextRequest} from "next/server";
import {GET,POST} from "../app/api/platform-admin/jwt-september-recovery/route";
import {deps} from "../app/api/platform-admin/jwt-invoice-preview/deps";
import {recoveryDeps} from "../app/api/platform-admin/jwt-september-recovery/deps";
async function main() {
  let writes=0;
  const response={ok:true,status:"running",phase:"collect",sourceScanned:0,total:235,processed:0,outcomes:[]};
  recoveryDeps.control=async()=>{writes++;return response;};
  recoveryDeps.status=async()=>response;
  const req=(body:unknown,origin="https://test.example")=>new NextRequest("https://test.example/api/platform-admin/jwt-september-recovery",{
    method:"POST",headers:{host:"test.example",origin,"content-type":"application/json"},body:JSON.stringify(body)});
  deps.requirePlatformAdmin=async()=>{throw new Error();};
  assert.equal((await GET()).status,403);
  assert.equal((await POST(req({action:"start"}))).status,403);
  deps.requirePlatformAdmin=async()=>({email:"test@example.test"}) as any;
  deps.enterprise=async()=>({name:"OTHER",shopIds:[227]});
  assert.equal((await POST(req({action:"start"}))).status,403);
  deps.enterprise=async()=>({name:"JWT",shopIds:[228]});
  assert.equal((await POST(req({action:"start"}))).status,403);
  deps.enterprise=async()=>({name:"JWT",shopIds:[227]});
  for(const body of [{action:"start",shopId:228},{action:"start",date:"2026-10-01"},null,[],{action:"delete"}])
    assert.equal((await POST(req(body))).status,400);
  assert.equal((await POST(req({action:"start"},"https://evil.example"))).status,400);
  assert.equal(writes,0);
  const started=await POST(req({action:"start"}));
  assert.equal(started.status,200);assert.equal(writes,1);
  assert.equal(started.headers.get("cache-control"),"no-store");
  deps.relayMode=()=>"relay";deps.interactive=async f=>f();
  deps.policy=async()=>({allowed:true,callbackOnly:true,allowInteractive:false});
  recoveryDeps.step=async read=>{await read(0);throw new Error("must not reach");};
  assert.equal((await POST(req({action:"step"}))).status,503);
  assert.equal(writes,1);
  console.log("JWT bulk auth, canonical scope, CSRF, overrides, no-store and provider policy: PASS");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
