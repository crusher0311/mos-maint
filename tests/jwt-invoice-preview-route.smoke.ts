import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "../app/api/platform-admin/jwt-invoice-preview/route";
import { deps } from "../app/api/platform-admin/jwt-invoice-preview/deps";

async function main() {
  let reads = 0;
  const request = (body: unknown = {}, origin = "https://example.test") => new NextRequest(
    "https://example.test/api/platform-admin/jwt-invoice-preview",
    { method:"POST", headers:{"content-type":"application/json",host:"example.test",origin},body:JSON.stringify(body) },
  );
  deps.requirePlatformAdmin = async () => { throw Error("unauthorized"); };
  deps.read = async () => { reads++; return {ok:true,data:{ItemCollection:[]}}; };
  assert.equal((await POST(request())).status,401);
  deps.requirePlatformAdmin = async () => ({email:"admin@example.test"}) as any;
  assert.equal((await POST(request({shopId:228}))).status,400);
  assert.equal((await POST(request({}, "https://evil.test"))).status,403);
  assert.equal(reads,0);
  deps.enterprise = async()=>({name:"JWT",shopIds:[227]});
  deps.relayMode = ()=>"relay";
  deps.interactive = async work=>work();
  deps.policy = async()=>({allowed:true,callbackOnly:true,allowInteractive:false});
  assert.equal((await POST(request())).status,409);
  assert.equal(reads,0);
  deps.policy = async()=>({allowed:true,callbackOnly:true,allowInteractive:true});
  const success=await POST(request());
  assert.equal(success.status,200);
  assert.equal(success.headers.get("cache-control"),"no-store");
  assert.equal(reads,1);
  let release!: () => void;
  deps.read = async()=>{await new Promise<void>(resolve=>{release=resolve;});return {ok:true,data:{ItemCollection:[]}};};
  const pending=POST(request());
  for(let i=0;i<20&&!release;i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(release);
  assert.equal((await POST(request())).status,429);
  release();
  assert.equal((await pending).status,200);
  console.log("JWT invoice preview route: ALL PASS (no network or database calls)");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
