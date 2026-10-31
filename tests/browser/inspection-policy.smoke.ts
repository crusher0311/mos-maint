import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdir} from "node:fs/promises";
import puppeteer from "puppeteer-core";
import {createPolicyFixture} from "./inspection-policy-fixture-server";
import {readCatalog} from "../../lib/auto-dvi/staff/sheet-catalog";

async function main() {
  const fixture = await createPolicyFixture();
  await new Promise<void>(resolve => fixture.server.listen(0, "127.0.0.1", resolve));
  const port = (fixture.server.address() as {port: number}).port;
  const browser = await puppeteer.launch({
    executablePath: execFileSync("which", ["chromium"], {encoding: "utf8"}).trim(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage(), errors: string[] = [], external: string[] = [];
    page.on("pageerror", e => errors.push(String(e)));
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.hostname !== "127.0.0.1") {external.push(request.url()); void request.abort();}
      else void request.continue();
    });
    await page.setViewport({width: 390, height: 844});
    await page.goto(`http://127.0.0.1:${port}/`);
    async function click(text: string) {
      await page.waitForFunction(t => [...document.querySelectorAll("button")].some(b => b.textContent === t && !b.disabled), {}, text);
      await page.evaluate(t => [...document.querySelectorAll("button")].find(b => b.textContent === t)!.click(), text);
    }
    await click("Edit inspection policy");
    const section = '[aria-label="Inspection completion policy"]';
    await page.select(`${section} select`, "captured-findings");
    // All delivery roles unchecked explicitly; publishing roles remain selected.
    await page.evaluate(selector => {
      const inputs = [...document.querySelectorAll<HTMLInputElement>(`${selector} input[type="checkbox"]`)];
      inputs.slice(3).forEach(input => input.click());
    }, section);
    assert.equal((await readCatalog(fixture.deps)).policy, null);
    await click("Save inspection policy");
    await page.waitForFunction(() => document.body.textContent?.includes("Policy v1"));
    let saved = await readCatalog(fixture.deps);
    assert.equal(saved.policy?.completionMode, "captured-findings");
    assert.deepEqual(saved.policy?.deliverRoles, []);
    assert.equal(saved.inspectionEnabled, false);
    await page.reload();
    await page.waitForFunction(() => document.body.textContent?.includes("Policy v1"));
    assert.ok(await page.$eval(section, el => el.textContent?.includes("Captured findings")));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await mkdir("generated-artifacts/inspection-policy", {recursive: true});
    await page.screenshot({path: "generated-artifacts/inspection-policy/mobile.png"});
    await page.setViewport({width: 1024, height: 768});
    await click("Edit inspection policy");
    await page.select(`${section} select`, "required-checks");
    await click("Save inspection policy");
    await page.waitForFunction(() => document.body.textContent?.includes("Policy v2"));
    saved = await readCatalog(fixture.deps);
    assert.equal(saved.policy?.version, 2);
    assert.equal(saved.policy?.completionMode, "required-checks");
    assert.equal(saved.inspectionEnabled, false);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log("PASS policy browser: phone/tablet, explicit save, Mongo readback, reload, empty delivery roles, gates unchanged, no external requests");
  } finally {await browser.close(); await fixture.close();}
}
void main().catch(error => {console.error(error); process.exitCode = 1;});
