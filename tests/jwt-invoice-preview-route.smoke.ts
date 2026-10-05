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
  deps.stored = async()=>[];
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
  const {readJwtInvoicePreviewStored} = await import("../lib/db/repositories/jwt-invoice-preview");
  const queries: string[] = [];
  const fake = {
    begin: async (mode: string, fn: any) => {
      assert.equal(mode,"read only");
      return fn({unsafe: async (sql: string, args?: string[]) => {
        queries.push(sql);
        if(sql.startsWith("SET LOCAL")) return [];
        assert.match(sql,/shop_id = 227/);
        assert.match(sql,/LIMIT 51/);
        assert.match(sql,/ANY\(\$1::text\[\]\)/);
        assert.ok(args?.[0].startsWith("{701"));
        return [];
      }});
    },
  };
  assert.deepEqual(await readJwtInvoicePreviewStored(fake as any),[]);
  assert.equal(queries.length,2);
  assert.ok(queries.every(q=>/^\s*(SET LOCAL statement_timeout|SELECT)/.test(q)));
  await assert.rejects(readJwtInvoicePreviewStored({begin:async(_:any,fn:any)=>fn({
    unsafe:async(sql:string)=>sql.startsWith("SET")?[]:Array(51).fill({}),
  })} as any),/oversized/);
  console.log("JWT bounded read-only repository: ALL PASS");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
