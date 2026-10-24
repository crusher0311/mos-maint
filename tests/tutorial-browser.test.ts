// Isolated production-presenter tests: no app server, credentials, or database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import puppeteer, { type Page } from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const source = readFileSync("mos-tools-extension/tutorials.js", "utf8").replace(/^export /gm, "");
const css = readFileSync("mos-tools-extension/tutorials.css", "utf8");
async function click(page: Page, text: string, index = 0) {
  await page.evaluate(({text,index}) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".mos-help button")].filter(n => n.textContent === text)[index];
    if (!button || button.disabled) throw new Error(`Missing enabled button: ${text}`);
    button.click();
  }, {text,index});
}
async function fixture(page: Page, options: {surface?: string; persistent?: boolean; canSave?: boolean; slow?: boolean; fail?: boolean} = {}) {
  await page.goto("about:blank");
  await page.setContent(`<button id="launch">Help & tutorials</button>
    <div data-tutorial="vhi" id="has-context">Vehicle and RO</div>
    <div data-tutorial="vhi-priorities" id="plan-content">Needs attention</div>
    <div id="overdue-section">Review recommendations</div><div id="tab-plan">VHI</div>
    <input id="job-search"><div id="lookup-results">Historical jobs</div>
    <div id="subtab-canned">Canned jobs</div><div id="tab-jobs">Jobs</div>
    <div id="tab-sticker" data-tutorial="printing"><input id="sticker-mileage">
      <div id="sticker-form">Printer settings</div><button id="sticker-print-btn">Print sticker</button></div>
    <button id="business">Add job</button><button id="print">Print</button>`);
  await page.addStyleTag({content:css});
  await page.addScriptTag({content:source + `
    window.calls=[]; window.business=0; window.releases=[]; window.fail=${!!options.fail};
    window.ctx={authenticated:true,features:['maintenance','job_lookup','oil_sticker'],current:'vhi',scope:'person-a|ro-a'};
    window.people={};
    window.persistent=${options.persistent !== false}; window.canSave=${options.canSave !== false};
    window.slow=${!!options.slow};
    window.getPerson=()=>ctx.scope.split('|')[0];
    window.serverState=()=>people[getPerson()] ||= {personId:getPerson(),persistent,canSave,state:{noticeSeen:false,dismissed:[],completed:[]}};
    window.request=async(method,body)=>{
      calls.push({method,body,person:getPerson()});
      if (fail) throw new Error('offline');
      const result=structuredClone(serverState());
      if (method==='PUT') {
        if (!canSave) throw new Error('forbidden');
        if (body.expectedPersonId !== getPerson()) throw new Error('Tutorial account changed');
        if (body.action==='notice') {
          result.showNotice=!serverState().state.noticeSeen;
          serverState().state.noticeSeen=true;
        } else {
          serverState().state[body.action==='complete'?'completed':'dismissed'].push(body.guide);
        }
        result.state=structuredClone(serverState().state);
      }
      if (slow) await new Promise(resolve=>releases.push(resolve));
      return result;
    };
    window.install=()=>window.help=createTutorials({surface:${JSON.stringify(options.surface || "extension")},request,getContext:()=>ctx});
    install();
    document.getElementById('launch').onclick=()=>help.open();
    document.getElementById('business').onclick=()=>business++;
    document.getElementById('print').onclick=()=>business++;
    document.getElementById('sticker-print-btn').onclick=()=>business++;
    window.print=()=>business++;
  `});
}
async function settle(page: Page) { await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 35))); }

test("optional production tutorials: safety, identity, replay and responsive callouts", async () => {
  const browser = await puppeteer.launch({executablePath:process.env.CHROMIUM_EXECUTABLE_PATH || await chromium.executablePath(), args:chromium.args, headless:true});
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  // Any accidental network access fails closed; fixture uses only in-memory state.
  page.on("request", req => { void req.abort(); });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await fixture(page);
    await settle(page);
    assert.equal(await page.$(".mos-help-panel"), null, "never starts a tour automatically");
    assert.ok(await page.$(".mos-help-notice"));
    await click(page,"Dismiss");
    await page.click("#launch");
    assert.equal(await page.evaluate(() => document.querySelector(".mos-help-guide h3")?.textContent), "Understand VHI recommendations");
    await click(page,"Not now");
    await settle(page);
    assert.equal(await page.evaluate(() => (window as any).people["person-a"].state.dismissed[0]),"vhi");
    await click(page,"Replay guide");
    assert.ok(await page.$(".mos-help-outline:not([hidden])"));
    await click(page,"Next");
    await click(page,"Back");
    assert.match(await page.$eval(".mos-help-panel",node=>node.textContent || ""),/Step 1 of 4/);
    await page.evaluate(() => document.getElementById("has-context")?.remove());
    await settle(page);
    assert.match(await page.$eval("[data-help-missing]",node=>node.textContent || ""),/not visible/);
    await page.keyboard.press("Escape");
    assert.equal(await page.$(".mos-help-panel"),null);
    assert.equal(await page.evaluate(()=>document.activeElement?.id),"launch","Escape restores launch focus");
    await page.click("#launch");
    await click(page,"Replay guide");
    await click(page,"Next"); await click(page,"Next"); await click(page,"Next"); await click(page,"Finish guide");
    await settle(page);
    assert.deepEqual(await page.evaluate(()=>(window as any).people["person-a"].state.completed),["vhi"]);
    assert.equal(await page.evaluate(()=>(window as any).business),0);
    assert.ok(await page.evaluate(()=>(window as any).calls.every((c:any)=>c.method==="GET" || ["notice","dismiss","complete"].includes(c.body.action))));
    assert.ok(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.method==="PUT").every((c:any)=>c.body.expectedPersonId===c.person)),"persistent writes carry the captured person precondition");

    await page.evaluate(()=>{ (window as any).help.destroy(); (window as any).install(); });
    await settle(page);
    assert.equal(await page.$(".mos-help-notice"),null,"notice is not repeated after host reload");
    await page.click("#launch");
    assert.match(await page.$eval(".mos-help-panel",node=>node.textContent || ""),/Completed/);
    await page.evaluate(()=>{ const w=window as any; w.ctx={...w.ctx,scope:"person-b|ro-a"}; w.help.sync(); });
    await settle(page);
    assert.equal(await page.$(".mos-help-panel"),null,"account switch closes help");
    await page.click("#launch");
    assert.doesNotMatch(await page.$eval(".mos-help-panel",node=>node.textContent || ""),/Completed|Dismissed/,"new person does not inherit choices");
    const readsBeforeFocus = await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.method==="GET").length);
    await page.evaluate(()=>window.dispatchEvent(new Event("focus"))); await settle(page);
    assert.ok(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.method==="GET").length) > readsBeforeFocus,"focus rechecks server identity/preferences");
    await page.evaluate(()=>{ const w=window as any; w.getPerson=()=>"person-c"; window.dispatchEvent(new Event("focus")); });
    await settle(page);
    assert.equal(await page.$(".mos-help-panel"),null,"server identity change closes even without host scope change");
    await page.evaluate(()=>{ const w=window as any; w.ctx={...w.ctx,features:[]}; w.help.sync(); });
    await settle(page); await page.click("#launch");
    assert.match(await page.$eval(".mos-help-panel",node=>node.textContent || ""),/No guides match/);
    assert.equal(await page.$(".mos-help-guide"),null,"unentitled guides are not exposed");

    for (const opts of [{persistent:false,canSave:false},{persistent:true,canSave:false}]) {
      await fixture(page,opts); await settle(page);
      assert.equal(await page.$(".mos-help-notice"),null);
      assert.equal(await page.evaluate(()=>(window as any).calls.some((c:any)=>c.method==="PUT")),false);
      await page.click("#launch"); await click(page,"Not now"); await settle(page);
      assert.equal(await page.evaluate(()=>(window as any).calls.some((c:any)=>c.method==="PUT")),false,"read-only/basic never writes");
      await click(page,"Replay guide");
      await page.evaluate(()=>{ const w=window as any; w.ctx={...w.ctx,scope:"person-a|new-provider-new-ro"}; w.help.sync(); });
      assert.equal(await page.$(".mos-help-panel"),null,"provider/RO switch closes walkthrough");
    }
    await fixture(page,{slow:true});
    await page.evaluate(()=>{ const w=window as any; w.ctx={...w.ctx,scope:"person-b|ro-b"}; w.help.sync(); w.releases[0](); });
    await settle(page);
    assert.equal(await page.$(".mos-help-notice"),null,"stale person-a read cannot claim a notice");
    await page.evaluate(()=>{ const w=window as any; w.slow=false; w.releases[1](); });
    await settle(page);
    assert.ok(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.method==="PUT").every((c:any)=>c.person==="person-b")));

    await fixture(page,{slow:true});
    await page.evaluate(()=>(window as any).releases[0]()); await settle(page);
    assert.equal(await page.evaluate(()=>(window as any).calls[1].body.action),"notice");
    await page.evaluate(()=>{ const w=window as any; w.ctx={...w.ctx,scope:"person-b|ro-b"}; w.help.sync(); w.releases[1](); });
    await settle(page);
    assert.equal(await page.$(".mos-help-notice"),null,"late atomic claimant cannot show notice after account/context switch");

    await fixture(page); await settle(page);
    await page.click("#launch"); await settle(page);
    await page.evaluate(()=>{ (window as any).getPerson=()=>"person-b"; });
    await click(page,"Not now"); await settle(page);
    assert.deepEqual(await page.evaluate(()=>(window as any).people["person-b"].state.dismissed),[],"stale cookie account cannot receive another person's dismissal");
    assert.equal(await page.evaluate(()=>(window as any).calls.at(-1).body.expectedPersonId),"person-a");
    assert.match(await page.$eval(".mos-help-panel",node=>node.textContent || ""),/Could not save dismissal/);

    await fixture(page,{surface:"web",fail:true}); await settle(page);
    await page.click("#launch");
    assert.match(await page.$eval(".mos-help-panel",node=>node.textContent || ""),/could not be loaded/);
    await page.evaluate(() => { (window as any).fail=false; });
    await click(page,"Retry preferences"); await settle(page);
    assert.doesNotMatch(await page.$eval(".mos-help-panel",node=>node.textContent || ""),/could not be loaded/);
    await click(page,"Start guide");
    await page.setViewport({width:320,height:568});
    await page.emulateMediaFeatures([{name:"prefers-reduced-motion",value:"reduce"}]);
    await settle(page);
    const box = await page.$eval(".mos-help-panel",node=>{
      const rect=node.getBoundingClientRect();
      return {left:rect.left,right:rect.right,bottom:rect.bottom,animation:getComputedStyle(node).animationName};
    });
    assert.ok(box.left>=0 && box.right<=320 && box.bottom<=568,"callout stays inside narrow viewport");
    assert.equal(box.animation,"none","reduced-motion disables reveal");
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(()=>(window as any).business),0,"no guide step invokes customer actions");
    // Every guide is executable without invoking the highlighted controls.
    for (const guide of ["jobs", "printing"]) {
      await fixture(page); await settle(page);
      await page.evaluate(id => {
        const w = window as any;
        w.ctx = {...w.ctx,current:id,scope:`person-a|${id}`}; w.help.sync();
      }, guide);
      await settle(page); await page.click("#launch"); await click(page,"Start guide");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.tagName),"BUTTON");
      await click(page,"Next"); await click(page,"Next"); await click(page,"Next"); await click(page,"Finish guide");
      await settle(page);
      assert.deepEqual(await page.evaluate(()=>(window as any).people["person-a"].state.completed),[guide]);
      assert.equal(await page.evaluate(()=>(window as any).business),0);
    }
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
