import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import puppeteer,{type Browser,type Page} from "puppeteer-core";
import {transferFixture} from "./check-in-transfer-server";

const endpoint="/api/dashboard/protractor/check-in-drafts";
const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
async function click(page:Page,text:string){
  await page.waitForFunction(text=>[...document.querySelectorAll("button")].some(b=>b.textContent?.includes(text)&&!b.disabled),{},text);
  await page.evaluate(text=>[...document.querySelectorAll("button")].find(b=>b.textContent?.includes(text))!.click(),text);
}
async function ready(page:Page){
  await page.waitForFunction(()=>(window as any).recovery?.ready&&!(window as any).recovery.busy);
}
async function local(page:Page){
  return page.evaluate(async()=>{
    const w=window as any,s=w.recovery.session;
    const saved=await w.readROSession(s.shopId,s.actorKey);
    return saved?{...saved,photos:await Promise.all(saved.photos.map(async(p:any)=>({
      ...p,blob:{type:p.blob.type,bytes:Array.from(new Uint8Array(await p.blob.arrayBuffer()))},
    })))}:null;
  });
}
async function main(){
  const fixture=await transferFixture();
  let browser:Browser|undefined;
  const errors:string[]=[],external:string[]=[];
  try{
    browser=await puppeteer.launch({executablePath:execFileSync("which",["chromium"],{encoding:"utf8"}).trim(),
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--disable-background-networking"]});
    const contexts=await Promise.all([browser.createBrowserContext(),browser.createBrowserContext()]);
    const [sender,recipient]=await Promise.all(contexts.map(c=>c.newPage()));
    for(const [i,page] of [sender,recipient].entries()){
      page.on("pageerror",e=>errors.push(String(e)));
      await page.setRequestInterception(true);
      page.on("request",req=>{
        if(new URL(req.url()).origin!==fixture.url){external.push(req.url());void req.abort();}
        else void req.continue();
      });
      await page.setViewport({width:390,height:844});
      await page.setCookie({name:"session_token",value:fixture.token(i?"recipient":"sender"),url:fixture.url,httpOnly:true});
      await page.goto(fixture.url);await ready(page);
      await page.evaluate(fields=>(window as any).recovery.saveDraft(fields),JSON.stringify({notes:i?"Recipient retained local notes":"Sender arrival notes"}));
      await page.waitForFunction(async()=>{
        const w=window as any,s=w.recovery.session;return !!(await w.readROSession(s.shopId,s.actorKey))?.draft;
      });
      await page.reload();await ready(page);
      assert.equal(await page.evaluate(()=>(window as any).recovery.needsResume),true);
      await page.evaluate(()=>(window as any).recovery.acceptDraft());
    }
    const senderLocal=await local(sender),recipientLocal=await local(recipient);
    assert.notEqual(senderLocal.handoffRequestId,recipientLocal.handoffRequestId);
    assert.notEqual(senderLocal.actorKey,recipientLocal.actorKey);
    const id=senderLocal.handoffRequestId;
    await sender.evaluate(async png=>{
      const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0));
      await (window as any).recovery.addPhoto(new File([bytes],"arrival.png",{type:"image/png"}));
      await (window as any).recovery.shareDraft(JSON.stringify({notes:"Sender arrival notes"}));
    },png);
    await sender.waitForFunction(()=>(window as any).recovery.sharedStatus==="saved");
    const shared=await local(sender),photo=shared.photos[0];
    assert.equal(photo.serverSaved,true);
    await sender.type('input[type="email"]',"recipient@example.invalid");
    await click(sender,"Check coworker access");
    await click(sender,"Save and offer transfer");
    await sender.waitForFunction(()=>document.body.innerText.includes("Editing is paused"));
    await click(sender,"Cancel transfer");
    await sender.waitForFunction(()=>!document.body.innerText.includes("Editing is paused"));
    await click(sender,"Save and offer transfer");
    await sender.waitForFunction(()=>document.body.innerText.includes("Editing is paused"));
    assert.equal(await sender.evaluate(()=>(window as any).recovery.sharedBlocked),true);
    // Another advisor cannot hydrate media until ownership actually moves.
    assert.equal(await recipient.evaluate(async url=>(await fetch(url)).status,`${endpoint}?id=${id}&photo=${photo.requestId}`),404);
    await click(recipient,"Refresh incoming transfers");
    const offered=await fixture.db.collection("guided_check_in_drafts").findOne({id});
    fixture.loseAcceptance();
    await click(recipient,"Accept ownership and open");
    await recipient.waitForFunction(()=>document.body.innerText.includes("Server save is not confirmed"));
    const accepted=await fixture.db.collection("guided_check_in_drafts").findOne({id});
    assert.equal(accepted!.session.actorKey,fixture.actor("recipient@example.invalid"));
    assert.equal(accepted!.revision,offered!.revision+1);
    assert.equal(accepted!.ownershipHistory.length,1);
    assert.equal(fixture.requests.filter(r=>r.body?.action==="accept").length,1,"no transparent or application acceptance replay");
    assert.deepEqual(await local(recipient),recipientLocal,"lost response never overwrites recipient's local draft");
    await recipient.reload();await ready(recipient);
    assert.equal(await recipient.evaluate(()=>(window as any).recovery.serverDraft?.id),id);
    await click(recipient,"Resume server draft");
    await recipient.waitForFunction(()=>document.body.innerText.includes("different retained draft"));
    assert.deepEqual(await local(recipient),recipientLocal,"explicit resume refuses to clobber local work");
    await click(recipient,"Discard local draft");await ready(recipient);
    assert.equal(await local(recipient),null);
    await click(recipient,"Resume server draft");
    await recipient.waitForFunction(()=>(window as any).recovery.sharedStatus==="saved");
    const hydrated=await local(recipient);
    assert.equal(hydrated.handoffRequestId,id);
    assert.equal(hydrated.draft.fields,senderLocal.draft.fields);
    assert.equal(hydrated.photos[0].requestId,photo.requestId);
    assert.deepEqual(hydrated.photos[0].blob,photo.blob,"private photo bytes hydrate without changing identity");
    assert.equal(hydrated.photos[0].missingOnDevice,false);
    // A new hook/device must explicitly claim again; saved bytes survive reload.
    await recipient.reload();await ready(recipient);
    assert.deepEqual((await local(recipient)).photos,hydrated.photos);
    assert.equal(await recipient.evaluate(()=>(window as any).recovery.sharedBlocked),true);
    await click(recipient,"Resume server draft");
    await recipient.waitForFunction(()=>(window as any).recovery.sharedStatus==="saved");
    assert.equal((await local(recipient)).handoffRequestId,id);
    // Former owner's IndexedDB copy remains, but cannot revive or alter ownership.
    await sender.reload();await ready(sender);
    assert.equal(await sender.evaluate(()=>(window as any).recovery.sharedBlocked),true);
    assert.equal((await local(sender)).handoffRequestId,id);
    await sender.evaluate(()=>(window as any).recovery.saveDraft('{"notes":"stale overwrite"}'));
    assert.equal((await local(sender)).draft.fields,senderLocal.draft.fields);
    await sender.evaluate(()=>(window as any).recovery.shareDraft('{"notes":"stale overwrite"}'));
    await sender.waitForFunction(()=>!!(window as any).recovery.error);
    const stale=await sender.evaluate(async({endpoint,id,photo,fence,snapshot})=>{
      const statuses=[];
      for(const action of ["claim","discard","save"]){
        statuses.push((await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({action,...fence,...(action==="save"?snapshot:{})})})).status);
      }
      statuses.push((await fetch(`${endpoint}?id=${id}&photo=${photo}`)).status);
      return statuses;
    },{endpoint,id,photo:photo.requestId,fence:shared.shared,
      snapshot:{session:{shopId:shared.shopId,actorKey:shared.actorKey,handoffRequestId:id,draft:shared.draft},
        photos:shared.photos.map((p:any)=>({requestId:p.requestId,name:p.name,mime:p.blob.type,size:p.blob.bytes.length}))}});
    assert.deepEqual(stale,[404,404,404,404]);
    const final=await fixture.db.collection("guided_check_in_drafts").findOne({id});
    assert.equal(final!.session.actorKey,fixture.actor("recipient@example.invalid"));
    assert.equal(final!.session.draft.fields,senderLocal.draft.fields);
    assert.equal(final!.ownershipHistory.length,1);
    assert.equal(await fixture.db.collection("guided_check_in_drafts").countDocuments(),1);
    assert.equal(await fixture.db.collection("guided_check_in_media").countDocuments(),1);
    assert.equal(fixture.requests.filter(r=>r.body?.action==="accept").length,1);
    assert.equal(fixture.requests.some(r=>!([endpoint,`${endpoint}/transfer`,"/api/dashboard/protractor/dvi-handoff"].includes(r.path))),false);
    assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    assert.equal(await recipient.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    console.log("PASS two isolated advisor sessions: real recovery hook, retained drafts, Mongo photo hydration, lost acceptance, reload and stale-owner fences");
  }finally{
    try{await browser?.close();}
    finally{await fixture.close();}
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
