import assert from "node:assert/strict";
import { withUpstreamTimeout } from "../lib/with-upstream-timeout";
import { deriveIdempotentUpstreamId } from "../lib/idempotent-create-id";
const Module = require("module"), load = Module._load;
let cached: any = null;
const db = { collection: (name: string) => ({
  findOne: async () => name === "sessions" ? { userId: "synthetic", shopId: 42 } : name === "users" ? {} : name === "shops" ? {integrationProvider:"protractor",protractor:{connectionId:"fake",apiKey:"fake"}} : cached,
  find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
}) };
Module._load = function(name: string, ...args: any[]) {
  if (name === "@/lib/extension-route-wrapper") return {withExtensionErrorMarker:(fn:any)=>fn};
  if (name === "@/lib/extension-route-guard") return {guardExtensionShopRequest:async()=>({ok:true,mosShopId:42,user:{_id:"synthetic"}})};
  if (name === "@/lib/extension-write-guard") return {checkExtensionWritePermission:()=>null};
  if (name === "@/lib/integrations/protractor/work-order-service") return {finalizeProtractorWorkOrderCreation:async()=>{}};
  if (name === "@/lib/mongo") return { getDb: async () => db };
  if (name === "next/headers") return { cookies: async () => ({ get: () => ({ value: "synthetic" }) }) };
  if (name === "@/lib/data/repositories/protractor-deferred-work") return {
    findDeferredWorkByShopAndVin: async () => cached,
    upsertDeferredWorkSnapshot: async () => { throw Error("unexpected cache write"); },
  };
  return load.call(this, name, ...args);
};
const client = require("../lib/integrations/protractor/client");
const h = client.__protractorClientTestHooks;
Object.assign(h, {
  resolveProtractorConfig: async () => ({ shopId: 42, configured: true, connectionId: "fake", apiKey: "fake", authentication: "fake" }),
  acquireDistributedRateLimitSlot: async () => ({ acquired: true }),
  acquireOutboundGate: async () => ({ allowed: true }),
  recordResponse: async () => {}, trackApiRequest: async () => {},
  getOperatorStop: async () => ({active:false}),
  retryBaseDelayMs: 1, sleep: async () => {},
});
async function main() {
  await assert.rejects(fetch("https://example.invalid"),/egress denied/);
  assert.equal(process.env.MONGODB_PASSWORD,undefined);
  assert.equal(process.env.SUPABASE_PROD_DATABASE_URL,undefined);
  const key = deriveIdempotentUpstreamId("contact", 42, "synthetic", "attempt");
  assert.notEqual(key, deriveIdempotentUpstreamId("contact", 43, "synthetic", "attempt"));
  assert.notEqual(key, deriveIdempotentUpstreamId("contact", 42, "other", "attempt"));
  for (const fault of ["429", "500", "503", "connection", "timeout", "slow"]) {
    let calls = 0;
    h.httpsRequest = async () => {
      calls++;
      if (fault === "connection") throw Error("ECONNRESET");
      if (fault === "timeout") throw Error("ETIMEDOUT");
      if (fault === "slow") { await new Promise(r => setTimeout(r, 35)); return {statusCode: 200, body: JSON.stringify({ID: key})}; }
      return { statusCode: Number(fault), body: "synthetic failure" };
    };
    const start = Date.now();
    const result = await client.createContact(42, {firstName: "Test", lastName: "Only"}, {priority: true, maxRetries: 1, contactId: key});
    assert.equal(result.ok, fault === "slow");
    assert.ok(calls <= 2);
    console.log(JSON.stringify({fault, calls, elapsedMs: Date.now()-start, ok: result.ok}));
  }
  // Actual timeout helper does not cancel an admitted write.
  let admissions = 0;
  const entities = new Map();
  h.httpsRequest = async (_url: string, _method: string, _headers: any, body: string) => {
    admissions++; const payload = JSON.parse(body); entities.set(payload.ID, payload);
    await new Promise(r => setTimeout(r, 30));
    throw Error("accepted acknowledgment lost");
  };
  const write = () => client.createContact(42, {firstName: "Test", lastName: "Only"}, {priority: true, maxRetries: 0, contactId: key});
  const pending = write();
  const timed = await withUpstreamTimeout(pending, 5, "synthetic-contact", {ok: false, timedOut: true});
  assert.equal(timed.timedOut, true);
  await Promise.all([pending, write()]);
  assert.equal(admissions, 2); assert.equal(entities.size, 1);
  console.log("PASS late completion and concurrent retry: two admissions, one ID under simulated upsert semantics; not provider proof");
  const vehicleId=deriveIdempotentUpstreamId("vehicle",42,"synthetic","vehicle-attempt");
  const vehicleBodies:string[]=[];
  h.httpsRequest=async(_url:string,_method:string,_headers:any,body:string)=>{
    vehicleBodies.push(body);throw Error("accepted SOAP acknowledgment lost");
  };
  for(let i=0;i<2;i++) assert.equal((await client.createServiceItem(42,{ownerId:key,vin:"SYNTHETIC"},{vehicleId,maxRetries:0,soapTimeoutMs:20})).ok,false);
  assert.equal(vehicleBodies.length,2);
  assert.equal(vehicleBodies[0],vehicleBodies[1]);
  assert.ok(vehicleBodies[0].includes(vehicleId));
  console.log("PASS SOAP ambiguity: identical scoped vehicle payload on two failed acknowledgments; no readback confirmation");
  cached = {fetchedAt: new Date(), items: [{ID:"deferred", Title:"Inspection"}]};
  admissions = 0;
  assert.equal((await client.fetchDeferredWorkWithCache(42,"SYNTHETIC","vehicle")).source,"cache");
  assert.equal(admissions,0);
  cached = {fetchedAt: new Date(0), items: [{ID:"old"}]};
  h.httpsRequest = async () => { admissions++; return {statusCode:400,body:"unavailable"}; };
  assert.equal((await client.fetchDeferredWorkWithCache(42,"SYNTHETIC","vehicle")).ok,false);
  assert.ok(admissions > 0);
  cached = null;
  assert.equal((await client.fetchDeferredWorkWithCache(42,"SYNTHETIC","vehicle")).ok,false);
  // Runtime route evidence: historical results need no provider, but expose no coverage freshness.
  const {NextRequest} = require("next/server");
  const history = require("../app/api/dashboard/protractor/job-history/route");
  const response = await history.GET(new NextRequest("http://fixture.invalid/?vin=SYNTHETIC"));
  assert.deepEqual(await response.json(), {ok:true,jobs:[]});
  console.log("BLOCKER history empty response has no completeness/freshness marker");
  const cannedRoute = require("../app/api/dashboard/protractor/canned-jobs/route");
  for(const fetchedAt of [new Date(),new Date(0)]) {
    cached={fetchedAt,items:[{ID:"cached",Title:"Synthetic cached job",ServicePackageLines:[{Description:"Labor",Quantity:1,Price:10}]}]};
    let calls=0;h.httpsRequest=async()=>{calls++;throw Error("provider down");};
    const res=await cannedRoute.GET(new NextRequest("http://fixture.invalid/"));
    const body=await res.json();
    assert.equal(body.ok,true);assert.equal(body.jobs.length,1);assert.equal(calls,0);
    assert.equal(body.fetchedAt,undefined);
  }
  console.log("BLOCKER dashboard canned route serves both warm and epoch-old content without freshness metadata");
  // Invoke the actual extension routes, retaining real client and identity derivation.
  for (const [kind,payload] of [
    ["contact",{firstName:"Synthetic",lastName:"Only"}],
    ["vehicle",{ownerId:key,vin:"SYNTHETIC"}],
    ["work-order",{contactId:key,vehicleId}],
  ] as const) {
    const route=require(`../app/api/extension/protractor/create-${kind}/route`);
    const bodies:string[]=[];
    h.httpsRequest=async(_url:string,_method:string,_headers:any,body:string)=>{
      bodies.push(body);throw Error("accepted write; acknowledgment lost");
    };
    const request=()=>new NextRequest("http://fixture.invalid/",{method:"POST",body:JSON.stringify({shopId:42,clientRequestId:"route-stable",...payload})});
    const results=await Promise.all([route.POST(request()),route.POST(request())]);
    assert.deepEqual(results.map((r:any)=>r.status),[500,500]);
    for(const res of results) assert.equal((await res.json()).success,undefined);
    assert.equal(bodies.length,2);
    assert.equal(bodies[0],bodies[1]);
    console.log(`PASS actual extension ${kind} routes: concurrent accepted/lost-ack responses are errors, identical scoped payloads, two admissions`);
  }
  h.getDb = async () => db;
  h.getShopPartCostRatio = async () => null;
  const woId = deriveIdempotentUpstreamId("workOrder",42,"synthetic","partial");
  for (const failure of ["readback", "child-write"]) {
    let posts=0, reads=0;
    h.httpsRequest = async (_url:string, method:string) => {
      if(method==="GET"){reads++;return failure==="readback" ? {statusCode:400,body:"readback unavailable"} :
        {statusCode:200,body:JSON.stringify({ID:woId,WorkOrderNumber:123,ServicePackages:{ItemCollection:[]}})};}
      posts++;
      return posts===1 ? {statusCode:200,body:JSON.stringify({ID:woId,WorkOrderNumber:123})} : {statusCode:400,body:"child rejected"};
    };
    const result = await client.createProtractorWorkOrder(42,{
      contactId:"contact",vehicleId:"vehicle",servicePackages:[{title:"Synthetic job",source:"history",lines:[{description:"Labor",lineType:"Labor",quantity:1,unitPrice:10}]}],
    },{interactive:true,workOrderId:woId,maxRetries:0});
    assert.equal(result.ok,true,"characterize existing partial-success bug rather than hide it");
    assert.ok(reads>0);
    assert.equal(posts,failure==="readback"?1:2);
    console.log(`BLOCKER ${failure}: actual create client returned ok:true although requested child set is absent; posts=${posts} reads=${reads}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
