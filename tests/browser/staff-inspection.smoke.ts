import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import puppeteer from "puppeteer-core";
import {createStaffBrowserFixture} from "./staff-inspection-fixture-server";
async function main() {
const fixture = await createStaffBrowserFixture();
await new Promise<void>(resolve => fixture.server.listen(24106, "127.0.0.1", resolve));
const browser = await puppeteer.launch({executablePath: execFileSync("which", ["chromium"], {encoding: "utf8"}).trim(),
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"]});
try {
  const page = await browser.newPage();
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(String(error)));
  page.setDefaultTimeout(15000);
  await page.goto("http://127.0.0.1:24106/");
  async function click(text: string) {
    try {await page.waitForFunction(text => [...document.querySelectorAll("button")].some(b => b.textContent?.includes(text) && !b.disabled), {}, text);}
    catch (e) {console.error(await page.evaluate(() => document.body.innerText)); throw e;}
    await page.evaluate(text => ([...document.querySelectorAll("button")].find(b => b.textContent?.includes(text)) as HTMLButtonElement).click(), text);
  }
  await click("Initialize");
  await page.waitForSelector('article input[type="number"]');
  assert.equal(await page.$eval('article input[type="number"]', e => (e as HTMLInputElement).value), "");
  await page.click('article input[type="radio"]');
  for (const input of await page.$$('article input[type="number"]')) await input.type("7");
  // Select tread unit independently; no numeric result is prefilled by choosing it.
  await page.select('article select[id$="-unit"]', "mm");
  await page.type("article textarea", "Technician measured each tread position manually.");
  await click("Save item evidence");
  await page.waitForFunction(() => document.body.innerText.includes("Saved — server receipt"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("article textarea")?.textContent?.includes("Technician measured"));
  await click("Mark internal inspection ready");
  await page.waitForFunction(() => document.body.innerText.includes("Current · technician-fixture"));
  await page.setCookie({name: "fixtureRole", value: "advisor", url: "http://127.0.0.1:24106"});
  await page.reload();
  await click("Record advisor review");
  await page.waitForFunction(() => document.body.innerText.includes("Current · advisor-fixture"));
  await page.reload();
  await page.waitForFunction(() => document.body.innerText.includes("Current · advisor-fixture"));
  assert.equal(failures.length, 0, failures.join("\n"));
  assert.ok(fixture.calls.every(c => c.includes("/api/shop-dispatch/inspection")), "No provider/publication route may be called");
  assert.equal((await fixture.fixture.deps.board.read(1)).visits.length, 2);
  console.log("PASS persisted technician → reload → advisor review → reload; no provider or publication calls");
} finally {await browser.close(); await fixture.close();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
