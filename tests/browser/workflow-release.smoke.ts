import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import puppeteer from "puppeteer-core";
import {createStaffBrowserFixture} from "./staff-inspection-fixture-server";
import {mutateStaff} from "../../lib/auto-dvi/staff/service";
import {blankFinding} from "../../lib/auto-dvi/staff/model";
async function main() {
  const fixture = await createStaffBrowserFixture(true);
  await fixture.fixture.initialize();
  await mutateStaff({visitId: "visit-one", requestId: randomUUID(), revision: 1,
    command: {type: "save", sheet: "fixture@1", item: "tire.lf", finding: {
      ...blankFinding(), rating: "yellow", notes: "PRIVATE INTERNAL SENTINEL",
      values: {inner: 4, unit: "mm"},
    }}}, fixture.fixture.deps);
  await new Promise<void>(resolve => fixture.server.listen(24106, "127.0.0.1", resolve));
  const browser = await puppeteer.launch({executablePath: execFileSync("which", ["chromium"], {encoding: "utf8"}).trim(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"]});
  try {
    const page = await browser.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    page.on("dialog", dialog => void dialog.accept());
    await page.setCookie({name: "fixtureRole", value: "advisor", url: "http://127.0.0.1:24106"});
    await page.goto("http://127.0.0.1:24106/");
    async function click(text: string) {
      await page.waitForFunction(text => [...document.querySelectorAll("button")].some(b => b.textContent?.includes(text) && !b.disabled), {}, text);
      await page.evaluate(text => ([...document.querySelectorAll("button")].find(b => b.textContent?.includes(text)) as HTMLButtonElement).click(), text);
    }
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
    assert.ok(fixture.calls.every(call => call.includes("/api/shop-dispatch/inspection") || call.includes("/api/workflow-report")));
    console.log("PASS advisor exact mobile preview → publish → link → customer → revoke; no provider calls");
  } finally {await browser.close(); await fixture.close();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
