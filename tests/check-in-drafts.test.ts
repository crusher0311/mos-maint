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
const coworker={shopId:66,actor:"b".repeat(64)},other={shopId:66,actor:"c".repeat(64)};
const senderEmail="sender@example.invalid",recipientEmail="recipient@example.invalid";
const allowed=async(email:string)=>email===senderEmail?scope:coworker;
test("explicit selected recipient accepts once; native identities and media stay unchanged; old account loses access",async()=>{
  const f=await fresh(),photoId=randomUUID(),bytes=Buffer.from("89504e470d0a1a0a00000000","hex");
  const fields=JSON.stringify({selectedContact:{id:randomUUID()},selectedVehicle:{id:randomUUID()},vin:"1HGCM82633A004352"});
  f.row=await repo.write(scope,{...f.body,action:"save",revision:1,session:{...f.body.session,draft:{version:1,fields}},
    photos:[{requestId:photoId,name:"arrival.png",mime:"image/png",size:bytes.length}]});
  f.row=await repo.write(scope,{action:"photo",...f.fence(),requestId:photoId,mime:"image/png",base64:bytes.toString("base64")});
  const before=structuredClone(f.row);
  f.row=await repo.transfer(scope,{action:"offer",...f.fence(),email:recipientEmail},allowed,senderEmail);
  await assert.rejects(repo.read(coworker,f.row.id),/not found/);
  await assert.rejects(repo.photo(coworker,f.row.id,photoId),/not found/);
  await assert.rejects(repo.fence(scope,f.fence()),/pending/);
  await assert.rejects(repo.write(scope,{action:"claim",...f.fence(),deviceId:randomUUID()}),/pending/);
  assert.equal((await repo.offers(other)).length,0);
  assert.equal((await repo.offers({...coworker,shopId:67})).length,0);
  const offer=(await repo.offers(coworker))[0],deviceId=randomUUID();
  await assert.rejects(repo.transfer(other,{action:"accept",id:offer.id,revision:offer.revision,deviceId},allowed,"other@example.invalid"));
  const accepted=await repo.transfer(coworker,{action:"accept",id:offer.id,revision:offer.revision,deviceId},allowed,recipientEmail);
  assert.equal(accepted.session.draft.fields,fields);assert.equal(accepted._id,before._id);
  assert.deepEqual(accepted.operations,before.operations);assert.deepEqual(accepted.photos,before.photos);
  assert.equal(accepted.session.actorKey,coworker.actor);
  assert.equal(accepted.ownershipHistory[0].from,scope.actor);assert.equal(accepted.ownershipHistory[0].acceptedBy,coworker.actor);
  assert.deepEqual((await repo.photo(coworker,offer.id,photoId)).bytes,bytes);
  await assert.rejects(repo.read(scope,offer.id),/not found/);
  await assert.rejects(repo.fence(scope,f.fence()));
  await assert.rejects(repo.photo(scope,offer.id,photoId));
  assert.equal((await repo.transfer(coworker,{action:"accept",id:offer.id,revision:offer.revision,deviceId},allowed,recipientEmail)).revision,accepted.revision);
  await assert.rejects(repo.transfer(coworker,{action:"accept",id:offer.id,revision:offer.revision,deviceId:randomUUID()},allowed,recipientEmail));
});
test("permission revocation on either side rejects acceptance without changing ownership; cancellation fences old offers",async()=>{
  const f=await fresh();
  f.row=await repo.transfer(scope,{action:"offer",...f.fence(),email:recipientEmail},allowed,senderEmail);
  const accept={action:"accept",id:f.row.id,revision:f.row.revision,deviceId:randomUUID()};
  for(const revoked of [senderEmail,recipientEmail]){
    await assert.rejects(repo.transfer(coworker,accept,async email=>{
      if(email===revoked)throw Error("Permission revoked");return allowed(email);
    },recipientEmail),/revoked/);
    assert.equal((await repo.read(scope,f.row.id)).revision,f.row.revision);
  }
  f.row=await repo.transfer(scope,{action:"cancel",...f.fence()},allowed,senderEmail);
  await assert.rejects(repo.transfer(coworker,accept,allowed,recipientEmail));
  await repo.fence(scope,f.fence());
});
test("simultaneous transfers and acceptances have exactly one winner",async()=>{
  const f=await fresh();
  const offers=await Promise.allSettled([recipientEmail,"other@example.invalid"].map(email=>
    repo.transfer(scope,{action:"offer",...f.fence(),email},async e=>e===senderEmail?scope:e===recipientEmail?coworker:other,senderEmail)));
  assert.equal(offers.filter(r=>r.status==="fulfilled").length,1);
  f.row=await repo.read(scope,f.row.id);
  const target=f.row.transfer.to===coworker.actor?coworker:other;
  const authorize=async(email:string)=>email===senderEmail?scope:target;
  const results=await Promise.allSettled([1,2].map(()=>repo.transfer(target,{action:"accept",...f.fence(),deviceId:randomUUID()},authorize,recipientEmail)));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((await repo.read(target,f.row.id)).ownershipHistory.length,1);
});
test("unresolved native intent, reserved operation, and odometer scan all block coworker transfer",async()=>{
  const f=await fresh(),payload={clientRequestId:randomUUID(),firstName:"Fixture"};
  f.row=await repo.write(scope,{...f.body,action:"save",revision:1,session:{...f.body.session,pendingCreates:{contact:payload}}});
  await assert.rejects(repo.transfer(scope,{action:"offer",...f.fence(),email:recipientEmail},allowed,senderEmail),/Resolve/);
  await repo.reserve(scope,f.fence(),"contact",payload);f.row=await repo.read(scope,f.row.id);
  await assert.rejects(repo.transfer(scope,{action:"offer",...f.fence(),email:recipientEmail},allowed,senderEmail),/Resolve/);
  await isolated.client.db("check_in").collection("guided_check_in_drafts").updateOne({id:f.row.id},{$set:{operations:{},session:f.body.session,scans:{photo:{state:"pending"}}}});
  await assert.rejects(repo.transfer(scope,{action:"offer",...f.fence(),email:recipientEmail},allowed,senderEmail),/Resolve/);
});
test("simultaneous acceptance of different drafts cannot overwrite recipient's active draft",async()=>{
  const f=await fresh(),id=randomUUID(),deviceId=randomUUID();
  const second=await repo.write(other,{action:"create",id,revision:0,deviceId,session:{...f.body.session,actorKey:other.actor,handoffRequestId:id},photos:[]});
  const a=await repo.transfer(scope,{action:"offer",...f.fence(),email:recipientEmail},allowed,senderEmail);
  const authorize=async(email:string)=>email===senderEmail?scope:email===recipientEmail?coworker:other;
  const b=await repo.transfer(other,{action:"offer",id,revision:second.revision,deviceId,email:recipientEmail},authorize,"other@example.invalid");
  const results=await Promise.allSettled([a,b].map(row=>repo.transfer(coworker,{action:"accept",id:row.id,revision:row.revision,deviceId:randomUUID()},authorize,recipientEmail)));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(await isolated.client.db("check_in").collection("guided_check_in_drafts").countDocuments({ownerKey:`66:${coworker.actor}`}),1);
});
