import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
const loader = Module as unknown as {_load:(id:string,...args:any[])=>any}, original = loader._load;
let revoked = false, session: any = {shopId: 1, email: "fixture@example.invalid"}, calls = 0;
const targets = [{itemId: "sheet@1/tire", name: "Left tire", sheet: "sheet@1", item: "tire", serviceKey: null}];
loader._load = function(id,...args) {
  if(id === "next/server") return {NextResponse: class extends Response {static json(v:any,i?:ResponseInit){return Response.json(v,i);}}};
  if(id === "@/lib/auth") return {getSession: async()=>session};
  if(id === "@/lib/extension-route-guard") return {checkShopFeatureGate: async()=>null};
  if(id === "@/lib/auto-dvi/staff/assistance-context") return {
    suggestionId: ()=>"stable-check",
    visitAssistanceContext: async(visitId:string,revision:number|string)=>{
      assert.equal(visitId,"selected"); assert.equal(Number(revision),7);
      return {shopId:1,visitId,revision:7,targets,vehicle:async()=>({vin:"1HGCM82633A004352",mileage:50000}),
        revalidate:async()=>{if(revoked)throw Object.assign(Error("Access changed"),{status:403});}};
    },
  };
  if(id === "@/lib/auto-dvi/service") return {composeAutoDvi:async(opts:any)=>{
    calls++;assert.equal(opts.vin,"1HGCM82633A004352");assert.equal(opts.shopId,1);
    return {ok:true,items:[{id:"vhi:oil",name:"Oil",source:"vhi",defaultRating:"red",bucket:"overdue"}],hidden:[]};
  }};
  if(id === "@/lib/auto-dvi/voice") return {extractVoiceFindings:async(shop:number,_b:unknown,_m:unknown,items:unknown)=>{
    calls++;assert.equal(shop,1);assert.deepEqual(items,targets);
    return {ok:true,transcript:"Synthetic observation",findings:[{itemId:targets[0].itemId,name:"Left tire",rating:"green",notes:"Observed",recommendation:null}]};
  }};
  if(id === "@/lib/ai") return {trackOpenAiCall:()=>{},getOpenAI:()=>({chat:{completions:{create:async()=>{
    calls++;return {choices:[{message:{content:JSON.stringify({assignments:[{index:0,item:"Left tire",label:"Tire photo"}]})}}]};
  }}}})};
  return original.call(this,id,...args);
};
const generate = require("../app/api/auto-dvi/generate/route");
const voice = require("../app/api/auto-dvi/voice/route");
const photos = require("../app/api/auto-dvi/photo-assign/route");
loader._load = original;
const jsonRequest = () => new Request("https://fixture.invalid/api/auto-dvi/generate", {method:"POST",
  body:JSON.stringify({visitId:"selected",revision:7,vin:"UNTRUSTED",shopId:999})});
function mediaRequest(kind:"voice"|"photos") {
  const form = new FormData();form.set("visitId","selected");form.set("revision","7");
  form.set("items",JSON.stringify([{itemId:"forged",name:"Forged target"}]));
  form.set(kind === "voice" ? "audio" : "photos",new File(["fixture"],"fixture", {type:kind === "voice" ? "audio/webm":"image/png"}));
  return new Request("https://fixture.invalid/api/auto-dvi/assistance",{method:"POST",body:form});
}
test("production generation endpoint uses selected-visit context and strips suggested ratings",async()=>{
  const response=await generate.POST(jsonRequest()), data=await response.json();
  assert.equal(response.status,200);assert.equal(data.visitId,"selected");assert.equal(data.revision,7);
  assert.equal(data.items[0].defaultRating,undefined);assert.equal(data.items[0].rating,undefined);
  revoked=true;assert.notEqual((await generate.POST(jsonRequest())).status,200);revoked=false;
});
test("production voice/photo endpoints ignore caller targets and return review-only revision-bound suggestions",async()=>{
  const dictation=await (await voice.POST(mediaRequest("voice"))).json();
  assert.equal(dictation.findings[0].itemId,"sheet@1/tire");assert.equal(dictation.revision,7);
  const assignment=await (await photos.POST(mediaRequest("photos"))).json();
  assert.equal(assignment.assignments[0].itemId,"sheet@1/tire");assert.equal(assignment.revision,7);
  revoked=true;
  assert.notEqual((await voice.POST(mediaRequest("voice"))).status,200);
  assert.notEqual((await photos.POST(mediaRequest("photos"))).status,200);
  revoked=false;
});
test("unauthenticated assistance performs no AI/composition work",async()=>{
  session=null;const before=calls;
  assert.equal((await generate.POST(jsonRequest())).status,401);
  assert.equal((await voice.POST(mediaRequest("voice"))).status,401);
  assert.equal((await photos.POST(mediaRequest("photos"))).status,401);
  assert.equal(calls,before);
});
