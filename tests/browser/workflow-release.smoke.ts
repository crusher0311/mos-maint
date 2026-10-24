import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import puppeteer from "puppeteer-core";
import {createStaffBrowserFixture} from "./staff-inspection-fixture-server";
import {snapshot} from "../../lib/auto-dvi/staff/service";
async function main() {
  const fixture = await createStaffBrowserFixture(true);
  await fixture.fixture.initialize();
  await new Promise<void>(resolve => fixture.server.listen(24106, "127.0.0.1", resolve));
  const browser = await puppeteer.launch({executablePath: execFileSync("which", ["chromium"], {encoding: "utf8"}).trim(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"]});
  try {
    const page = await browser.newPage();
    const external: string[] = [];
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.protocol === "data:") {void request.continue(); return;}
      if (url.hostname !== "127.0.0.1") {external.push(request.url()); void request.abort(); return;}
      if (url.pathname.startsWith("/api/auto-dvi/")) {
        void snapshot("visit-one", fixture.fixture.deps).then(s => {
          const target = {itemId:"fixture@1/tire.lf", sheet:"fixture@1", item:"tire.lf", name:"Left tire"};
          const content = url.pathname.endsWith("generate")
            ? {items:[{id:"scope-oil",name:"Synthetic suggested oil check",source:"vhi",reference:"vhi:oil"}],hidden:[]}
            : url.pathname.endsWith("voice")
              ? {findings:[{itemId:target.itemId,name:target.name,rating:"green",notes:"PRIVATE INTERNAL SENTINEL",recommendation:null}],targets:[target]}
              : {assignments:[{index:0,itemId:target.itemId,label:"Synthetic tire photo"}],targets:[target]};
          return request.respond({status:200,contentType:"application/json",
            body:JSON.stringify({ok:true,visitId:"visit-one",revision:s.inspection!.revision,...content})});
        });
      } else void request.continue();
    });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    page.on("dialog", dialog => void dialog.accept());
    await page.setCookie({name: "fixtureRole", value: "advisor", url: "http://127.0.0.1:24106"});
    await page.goto("http://127.0.0.1:24106/");
    async function click(text: string) {
      await page.waitForFunction(text => [...document.querySelectorAll("button")].some(b => b.textContent?.includes(text) && !b.disabled), {}, text);
      await page.evaluate(text => ([...document.querySelectorAll("button")].find(b => b.textContent?.includes(text)) as HTMLButtonElement).click(), text);
    }
    await page.waitForSelector('details summary');
    await page.evaluate(() => [...document.querySelectorAll("summary")].find(s => s.textContent?.includes("Inspection assistance"))?.click());
    await click("Suggest VHI");
    await page.waitForFunction(() => document.body.innerText.includes("Synthetic suggested oil check"));
    await page.evaluate(() => {
      const label = [...document.querySelectorAll("label")].find(l => l.textContent?.includes("Synthetic suggested oil check"));
      (label?.querySelector("input") as HTMLInputElement).click();
    });
    await click("Confirm selected checks");
    await page.waitForSelector('[data-testid="inspection-item-scope-oil"]');
    assert.equal((await snapshot("visit-one", fixture.fixture.deps)).inspection!.sheets.at(-1)!.results["scope-oil"], undefined);
    async function upload(selector: string, mime: string, bytes: number[]) {
      await page.evaluate(({selector,mime,bytes}) => {
        const input=document.querySelector(selector) as HTMLInputElement, transfer=new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)],"fixture",{type:mime}));
        input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));
      },{selector,mime,bytes});
    }
    await upload('input[accept="audio/*"]',"audio/webm",[1,2,3]);
    await click("Confirm into unsaved item draft");
    assert.equal((await snapshot("visit-one", fixture.fixture.deps)).inspection!.sheets[0].results["tire.lf"], undefined);
    await page.waitForSelector('article input[type="radio"]');
    await page.click('article input[type="radio"]');
    await page.select('article select[id$="-unit"]', "mm");
    await page.type('article input[id$="-inner"]', "4");
    await click("Save item evidence");
    await page.waitForFunction(() => document.body.innerText.includes("Saved — server receipt"));
    const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64");
    await upload('input[multiple][accept="image/jpeg,image/png,image/webp"]',"image/png",[...png]);
    await page.waitForFunction(()=>document.body.innerText.includes("Synthetic tire photo"));
    assert.equal((await snapshot("visit-one", fixture.fixture.deps)).inspection!.sheets[0].results["tire.lf"].photos.length,0);
    await click("Confirm assignment and upload");
    await page.waitForSelector('img[alt^="Saved evidence"]');
    assert.equal((await snapshot("visit-one", fixture.fixture.deps)).inspection!.sheets[0].results["tire.lf"].photos.length,1);
    await page.waitForSelector('[data-testid="inspection-release-panel"] article input[type="checkbox"]');
    await page.click('[data-testid="inspection-release-panel"] article input[type="checkbox"]');
    await page.waitForSelector('textarea[placeholder="Write what the customer should understand."]');
    await page.type('textarea[placeholder="Write what the customer should understand."]', "Customer-approved tire finding");
    await click("Prepare customer preview");
    await page.waitForFunction(() => document.body.innerText.includes("Proposed report · not published"));
    await click("Mobile");
    await click("Publish this exact preview");
    await click("Create access link");
    await page.waitForSelector('input[aria-label="Customer report link"]');
    const url = await page.$eval('input[aria-label="Customer report link"]', input => (input as HTMLInputElement).value);
    const customer = await browser.newPage();
    await customer.setViewport({width: 390, height: 844});
    await customer.goto(url);
    await customer.waitForFunction(() => document.body.innerText.includes("Customer-approved tire finding"));
    assert.ok(!(await customer.content()).includes("PRIVATE INTERNAL SENTINEL"));
    await click("Revoke");
    await customer.reload();
    await customer.waitForFunction(() => document.body.innerText.toLowerCase().includes("unavailable"));
    assert.ok(!(await customer.content()).includes("Customer-approved tire finding"));
    assert.equal(errors.length, 0, errors.join("\n"));
    assert.deepEqual(external, []);
    assert.ok(fixture.calls.every(call => call.includes("/api/shop-dispatch/inspection") ||
      call.includes("/api/workflow-report") || call.includes("/api/dashboard/protractor/arrival-photos")));
    console.log("PASS advisor exact mobile preview → publish → link → customer → revoke; no provider calls");
  } finally {await browser.close(); await fixture.close();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
