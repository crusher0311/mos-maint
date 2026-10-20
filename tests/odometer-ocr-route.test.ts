import test from "node:test";
import assert from "node:assert/strict";
const Module=require("module"),original=Module._load;
let authorized=true,budget=false,calls=0,stored:any=null,response:any={reading:123456,unit:"miles",confidence:"high",kind:"odometer"},fails=false,reserved=false;
const drafts={
  fence:async()=>{},photo:async()=>({mime:"image/png",bytes:Buffer.from("89504e470d0a1a0a00000000","hex")}),
  reserveScan:async()=>{if(reserved)return {send:false,result:stored};reserved=true;return {send:true};},
  confirmScan:async(_s:any,_id:any,_p:any,result:any)=>{stored=result;},
};
Module._load=function(name:string,...args:any[]){
  if(name==="@/lib/auth")return {getSession:async()=>authorized?{email:"fixture@example.invalid"}:null};
  if(name==="@/lib/auto-dvi/staff/check-in-access")return {checkInAccess:async()=>({shopId:66,actor:"a".repeat(64)})};
  if(name==="@/lib/data/repositories/check-in-drafts"){
    const real=original.call(this,name,...args);return {...real,CheckInDrafts:class{constructor(){return drafts;}}};
  }
  if(name==="@/lib/ai")return {trackOpenAiCall:()=>{},getOpenAI:()=>({chat:{completions:{create:async()=>{
    calls++;if(fails)throw Error("private provider error");return {choices:[{message:{content:JSON.stringify(response)}}]};
  }}}})};
  if(name==="@/lib/ai-budget")return {enforceAiBudget:async()=>budget?new Response("blocked",{status:429}):null};
  return original.call(this,name,...args);
};
const route=require("../app/api/dashboard/protractor/odometer-ocr/route");Module._load=original;
const id="12345678-1234-4234-8234-123456789abc";
function request(origin="https://fixture.invalid"){return new Request("https://fixture.invalid/api/dashboard/protractor/odometer-ocr",{method:"POST",
  headers:{origin,host:"fixture.invalid","content-type":"application/json"},
  body:JSON.stringify({_guidedDraft:{id,revision:1,deviceId:id},photoRequestId:id,interpretationRequestId:id})});}
test("real OCR route rejects unauthorized, cross-origin and budget-blocked requests before paid calls",async()=>{
  authorized=false;assert.equal((await route.POST(request())).status,401);authorized=true;
  assert.equal((await route.POST(request("https://other.invalid"))).status,403);
  budget=true;assert.equal((await route.POST(request())).status,429);budget=false;assert.equal(calls,0);
});
test("real route retains and reuses exact interpretation without a second OpenAI call",async()=>{
  const first=await route.POST(request());assert.equal(first.status,200);assert.equal((await first.json()).result.reading,123456);
  assert.equal((await route.POST(request())).status,200);assert.equal(calls,1);
});
test("malformed output and provider failure never leak details or fabricate a reading",async()=>{
  reserved=false;stored=null;response={reading:4,kind:"trip",unit:"miles",confidence:"high"};
  assert.equal((await route.POST(request())).status,503);
  reserved=false;fails=true;
  const r=await route.POST(request());assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/private provider/);
});
