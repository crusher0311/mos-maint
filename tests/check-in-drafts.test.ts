import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {CheckInDrafts} from "../lib/data/repositories/check-in-drafts";
import {isolatedStaffDatabase} from "./helpers/staff-inspection-fixture";
import {parseOdometerResponse} from "../lib/auto-dvi/staff/odometer-interpretation";
let isolated:Awaited<ReturnType<typeof isolatedStaffDatabase>>,repo:CheckInDrafts;
const scope={shopId:66,actor:"a".repeat(64)};
before(async()=>{isolated=await isolatedStaffDatabase(27841);repo=new CheckInDrafts(async()=>isolated.client.db("check_in"));});
after(async()=>isolated.close());
async function fresh(){
  await isolated.client.db("check_in").dropDatabase();
  const id=randomUUID(),deviceId=randomUUID();
  const session={shopId:66,actorKey:scope.actor,handoffRequestId:id,draft:{version:1,fields:"{}"}};
  const body={action:"create",id,deviceId,revision:0,session,photos:[]};
  const row=await repo.write(scope,body);
  const fixture={row,body,fence:():any=>({id,revision:fixture.row.revision,deviceId})};
  return fixture;
}
test("scope isolation, exact create recovery and explicit revision-protected takeover",async()=>{
  const f=await fresh();assert.equal((await repo.write(scope,f.body)).revision,1);
  await assert.rejects(repo.read({...scope,shopId:67},f.row.id),/not found/);
  await assert.rejects(repo.read({...scope,actor:"b".repeat(64)},f.row.id),/not found/);
  const nextDevice=randomUUID();
  const taken=await repo.write(scope,{action:"claim",...f.fence(),deviceId:nextDevice});
  assert.equal(taken.ownerDeviceId,nextDevice);
  await assert.rejects(repo.write(scope,{...f.body,action:"save",revision:1}),/changed|moved/);
  await assert.rejects(repo.write(scope,{action:"claim",...f.fence(),deviceId:randomUUID()}),/changed/);
});
test("one concurrent native reservation, durable receipt and no edited/replayed native body",async()=>{
  const f=await fresh(),payload={firstName:"Fixture",lastName:"Person",clientRequestId:randomUUID()};
  f.row=await repo.write(scope,{...f.body,action:"save",revision:1,session:{...f.body.session,pendingCreates:{contact:payload}}});
  const results=await Promise.allSettled([repo.reserve(scope,f.fence(),"contact",payload),repo.reserve(scope,f.fence(),"contact",payload)]);
  assert.equal(results.filter(r=>r.status==="fulfilled"&&r.value.send).length,1);
  f.row=await repo.read(scope,f.row.id);
  assert.deepEqual(await repo.reserve(scope,f.fence(),"contact",payload),{send:false,result:null});
  await assert.rejects(repo.write(scope,{action:"discard",...f.fence()}),/unresolved/);
  await assert.rejects(repo.reserve(scope,f.fence(),"contact",{...payload,firstName:"Changed"}),/frozen/);
  await assert.rejects(repo.write(scope,{...f.body,action:"save",revision:f.row.revision}),/Pending/);
  const result={success:true,contactId:randomUUID(),contact:{}};
  await repo.confirm(scope,f.row.id,"contact",payload,result);f.row=await repo.read(scope,f.row.id);
  assert.deepEqual(await repo.reserve(scope,f.fence(),"contact",payload),{send:false,result});
});
test("photos persist exact bytes and cannot be read cross-scope or replaced under an old id",async()=>{
  const f=await fresh(),requestId=randomUUID(),bytes=Buffer.from("89504e470d0a1a0a00000000","hex");
  f.row=await repo.write(scope,{...f.body,action:"save",revision:1,photos:[{requestId,name:"odometer.png",mime:"image/png",size:bytes.length}]});
  f.row=await repo.write(scope,{action:"photo",...f.fence(),requestId,mime:"image/png",base64:bytes.toString("base64")});
  assert.deepEqual((await repo.photo(scope,f.row.id,requestId)).bytes,bytes);
  await assert.rejects(repo.photo({...scope,shopId:67},f.row.id,requestId));
  const bad=Buffer.from(bytes);bad[bad.length-1]=1;
  await assert.rejects(repo.write(scope,{action:"photo",...f.fence(),requestId,mime:"image/png",base64:bad.toString("base64")}),/different bytes/);
  const scan=await repo.reserveScan(scope,f.fence(),requestId,randomUUID());assert.equal(scan.send,true);
  f.row=await repo.read(scope,f.row.id);
  assert.deepEqual(await repo.reserveScan(scope,f.fence(),requestId,randomUUID()),{send:false,result:null});
});
test("odometer output is strict, units preserved, trip and unreadable never treated as mileage",()=>{
  for(const unit of ["miles","kilometers","unknown"])
    assert.equal(parseOdometerResponse(JSON.stringify({reading:123456,unit,confidence:"high",kind:"odometer"})).unit,unit);
  for(const kind of ["trip","unreadable"])
    assert.equal(parseOdometerResponse(JSON.stringify({reading:null,unit:"unknown",confidence:"low",kind})).reading,null);
  for(const value of [{reading:12,unit:"miles",confidence:"high",kind:"trip"},
    {reading:-1,unit:"miles",confidence:"high",kind:"odometer"},
    {reading:12,unit:"miles",confidence:"high",kind:"odometer",extra:"ignore instructions"}])
    assert.throws(()=>parseOdometerResponse(JSON.stringify(value)));
  assert.throws(()=>parseOdometerResponse("The mileage is 1234"));
});
