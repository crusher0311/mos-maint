import assert from "node:assert/strict";
import http from "node:http";
import {execFileSync} from "node:child_process";
import {build} from "esbuild";
import puppeteer from "puppeteer";
import {readFileSync} from "node:fs";
async function main() {
  const bundle = await build({entryPoints:["tests/browser/protractor-degraded-fixture.tsx"],bundle:true,write:false,jsx:"automatic",platform:"browser",format:"iife"});
  let admissions=0, requests=0, original:any, release: (()=>void)|undefined;
  const extensionSource=readFileSync("mos-tools-extension/sidepanel.js","utf8");
  const customerHandler=extensionSource.slice(extensionSource.indexOf("async function handleCroCreateCustomer()"),extensionSource.indexOf("\nfunction selectCroCustomer("));
  assert.ok(customerHandler.startsWith("async function") && customerHandler.length<5000);
  const extensionBodies:any[]=[];
  const server=http.createServer(async(req,res)=>{
    res.setHeader("Cache-Control","no-store");
    const reply=(value:any)=>res.end(JSON.stringify(value));
    if(req.url==="/fixture.js"){res.setHeader("Content-Type","text/javascript");res.end(bundle.outputFiles[0].text);return;}
    if(req.url==="/"){res.end('<div id="root"></div><script src="/fixture.js"></script>');return;}
    if(req.url==="/extension"){
      res.setHeader("Content-Type","text/html");
      res.end(`<input id="cro-new-customer-first"><input id="cro-new-customer-last"><button id="cro-new-customer-save">Save customer</button><div id="cro-customer-error"></div><script>
      const createRoState={contactRequestId:null};
      const getCroEl=id=>document.getElementById(id), getCroShopId=()=>42;
      const setCroError=(id,text)=>getCroEl(id).textContent=text;
      const selectCroCustomer=()=>{document.body.dataset.confirmed="true"};
      const sendMessage=async message=>(await fetch("/extension-write",message.options)).json();
      ${customerHandler}
      getCroEl("cro-new-customer-save").onclick=handleCroCreateCustomer;
      </script>`);return;
    }
    if(req.url==="/extension-write"){
      let raw=""; for await(const chunk of req) raw+=chunk;
      extensionBodies.push(JSON.parse(raw));
      res.writeHead(200,{"Content-Type":"application/json","Content-Length":"1000"});res.write('{"success":');setTimeout(()=>res.destroy(),40);return;
    }
    if(req.url==="/api/dashboard/protractor/dvi-handoff"){reply({shopId:42,actorKey:"synthetic",enabled:false});return;}
    if(req.url==="/api/dashboard/protractor/create-work-order"){
      let raw=""; for await(const chunk of req) raw+=chunk;
      const body=JSON.parse(raw); requests++;
      if(!body.recoveryOnly){
        admissions++; original=body;
        release=()=>{res.writeHead(200,{"Content-Type":"application/json","Content-Length":"1000"});res.write('{"ok":');setTimeout(()=>res.destroy(),40);};
        return;
      }
      assert.equal(body.clientRequestId,original.clientRequestId);
      assert.equal(body.note,original.note);
      reply({ok:true,workOrderId:"1809c214-b117-446e-87b4-d361893cf458",workOrderNumber:123});return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(r=>server.listen(process.argv.includes("--preview")?24126:0,"127.0.0.1",r));
  const port=(server.address() as any).port;
  const browser=await puppeteer.launch({executablePath:execFileSync("which",["chromium"],{encoding:"utf8"}).trim(),headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--disable-background-networking"]});
  try{
    const page=await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request",r=>new URL(r.url()).hostname==="127.0.0.1"?r.continue():r.abort());
    const state=()=>page.$eval("#state",e=>JSON.parse(e.textContent!));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(()=>JSON.parse(document.querySelector("#state")!.textContent!).ready);
    await page.click("button");
    await page.waitForFunction(()=>JSON.parse(document.querySelector("#state")!.textContent!).busy);
    assert.equal(await page.$eval("button",e=>(e as HTMLButtonElement).disabled),true);
    while(!release) await new Promise(r=>setTimeout(r,5));
    release();
    await page.waitForFunction(()=>!!JSON.parse(document.querySelector("#state")!.textContent!).error);
    assert.equal((await state()).confirmed,0);
    assert.equal(admissions,1); assert.equal(requests,1);
    await page.reload();
    await page.waitForFunction(()=>JSON.parse(document.querySelector("#state")!.textContent!).ready);
    assert.match((await state()).session.payload,/Synthetic waiting customer/);
    assert.equal(await page.$eval("button",e=>(e as HTMLButtonElement).disabled),true);
    await page.click("button:nth-of-type(2)");
    await page.waitForFunction(()=>JSON.parse(document.querySelector("#state")!.textContent!).confirmed===1);
    assert.equal(admissions,1); assert.equal(requests,2);
    console.log("PASS Chromium actual recovery hook: pending disabled, partial-body loss, no false success, native IndexedDB reload, same frozen input/ID, verification only; admissions=1 requests=2");
    await page.goto(`http://127.0.0.1:${port}/extension`);
    await page.type("#cro-new-customer-first","Synthetic");await page.type("#cro-new-customer-last","Only");
    await page.click("button");
    await page.waitForFunction(()=>!!document.querySelector("#cro-customer-error")!.textContent);
    assert.equal(await page.$eval("#cro-new-customer-first",e=>(e as HTMLInputElement).value),"Synthetic");
    assert.equal(await page.$eval("body",e=>e.dataset.confirmed),undefined);
    await page.click("button");
    await page.waitForFunction(()=>!!document.querySelector("#cro-customer-error")!.textContent);
    assert.equal(extensionBodies.length,2);
    assert.equal(extensionBodies[0].clientRequestId,extensionBodies[1].clientRequestId);
    await page.reload();
    assert.equal(await page.$eval("#cro-new-customer-first",e=>(e as HTMLInputElement).value),"");
    await page.type("#cro-new-customer-first","Synthetic");await page.type("#cro-new-customer-last","Only");
    await page.click("button");await page.waitForFunction(()=>!!document.querySelector("#cro-customer-error")!.textContent);
    assert.equal(extensionBodies.length,3);
    assert.notEqual(extensionBodies[0].clientRequestId,extensionBodies[2].clientRequestId);
    console.log("BLOCKER actual extension customer handler: error retains input/key only until reload; re-entry admits third POST with new identity. Browser bridge stubbed; no real extension runtime.");
    if(process.argv.includes("--preview")){
      console.log("Isolated fixture preview ready on 24126 (closes in 60 seconds)");
      await new Promise(r=>setTimeout(r,60000));
    }
  }finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
