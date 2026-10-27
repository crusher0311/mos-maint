import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
test("AI reporting authenticates before reads, rejects broad windows, reports limits/errors",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ai-usage-route-"));
  const state={session:null as any,reads:0,rows:[] as any[],fail:false};
  (globalThis as any).__aiUsageTest=state;
  try {
    const out=await build({entryPoints:["app/api/platform-admin/openai-usage/route.ts"],bundle:true,write:false,platform:"node",format:"esm",
      plugins:[{name:"offline",setup(b){
        b.onResolve({filter:/^(next\/server|@\/lib\/auth|@\/lib\/data\/repositories\/openai-usage)$/},a=>({path:a.path,namespace:"fake"}));
        b.onLoad({filter:/.*/,namespace:"fake"},a=>({loader:"js",contents:a.path==="next/server"
          ? `export const NextResponse={json:(body,init)=>new Response(JSON.stringify(body),{...init,headers:{'Content-Type':'application/json',...init?.headers}})};`
          : a.path.endsWith("/auth") ? `export const getSession=async()=>globalThis.__aiUsageTest.session;`
          : `export const getOpenAiUsageRows=async()=>{const s=globalThis.__aiUsageTest;s.reads++;if(s.fail)throw Error('private');return s.rows;};`}));
      }}]});
    const file=join(dir,"route.mjs");await writeFile(file,out.outputFiles[0].text);
    const {GET}=await import(pathToFileURL(file).href);
    const call=(days="30")=>GET({nextUrl:new URL(`https://offline.test/?days=${days}`)});
    assert.equal((await call()).status,401);state.session={isPlatformAdmin:false};
    assert.equal((await call()).status,403);assert.equal(state.reads,0);
    state.session={isPlatformAdmin:true};assert.equal((await call("365")).status,400);assert.equal(state.reads,0);
    state.rows=Array.from({length:10001},()=>({timestamp:new Date(),endpoint:"old"}));
    const response=await call();const body=await response.json();
    assert.equal(body.truncated,true);assert.equal(body.totals.requests,10000);
    assert.equal(body.totals.unpricedRequests,10000);assert.equal(response.headers.get("cache-control"),"no-store");
    state.fail=true;assert.equal((await call()).status,503);
  } finally {delete (globalThis as any).__aiUsageTest;await rm(dir,{recursive:true,force:true});}
});
