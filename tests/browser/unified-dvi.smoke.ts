import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import puppeteer from "puppeteer-core";
import {createStaffBrowserFixture} from "./staff-inspection-fixture-server";
import {snapshot} from "../../lib/auto-dvi/staff/service";
async function main() {
  const fixture = await createStaffBrowserFixture(true, false, true);
  await fixture.fixture.initialize();
  await new Promise<void>(resolve => fixture.server.listen(24109, "127.0.0.1", resolve));
  const browser = await puppeteer.launch({executablePath: execFileSync("which", ["chromium"], {encoding: "utf8"}).trim(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"]});
  try {
    const page = await browser.newPage(), errors: string[] = [], external: string[] = [];
    page.setDefaultTimeout(15000);
    page.on("dialog", dialog => {void dialog.accept();});
    page.on("pageerror", e => errors.push(String(e)));
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.hostname !== "127.0.0.1") {external.push(request.url()); void request.abort();}
      else void request.continue();
    });
    await page.goto("http://127.0.0.1:24109/");
    await page.waitForSelector('[data-testid="inspection-item-tire.lf"]');
    const selector = (id: string) => `[data-testid="inspection-item-${id}"]`;
    const field = (id: string, key: string) => `${selector(id)} [id$="-${key}"]`;
    async function clickText(text: string) {
      await page.waitForFunction(t => [...document.querySelectorAll("button")].some(b => b.textContent?.includes(t) && !b.disabled), {}, text);
      await page.evaluate(t => ([...document.querySelectorAll("button")].find(b => b.textContent?.includes(t)) as HTMLButtonElement).click(), text);
    }
    async function save(id: string, revision: number) {
      await page.$eval(`${selector(id)} form`, form => (form as HTMLFormElement).requestSubmit());
      await page.waitForFunction(r => document.body.innerText.includes(`Revision ${r + 1} ·`), {}, revision);
    }
    for (const [index, wheel] of ["lf", "rf", "lr", "rr"].entries()) {
      const id = `tire.${wheel}`;
      await page.type(field(id, "actualSize"), index < 2 ? "225/45R18" : "255/40R18");
      await page.select(field(id, "availability"), "measured");
      await page.select(field(id, "unit"), "32nds");
      for (const key of ["inner", "center", "outer"]) await page.type(field(id, key), "7");
      if (index === 0) {
        await page.select(field(id, "unit"), "mm");
        assert.equal(await page.$eval(field(id, "inner"), e => (e as HTMLInputElement).value), "");
        for (const key of ["inner", "center", "outer"]) await page.type(field(id, key), "6");
      }
      await page.type(field(id, "beforePsi"), "34");
      await page.click(`${selector(id)} input[type="radio"]`);
      await page.type(`${selector(id)} textarea`, "Manually measured; green condition documented.");
      assert.equal(await page.$eval(field(id, "afterPsi"), e => (e as HTMLInputElement).value), "");
      const s = await snapshot("visit-one", fixture.fixture.deps);
      await save(id, s.inspection!.revision);
    }
    await page.select(field("battery", "outcome"), "pass");
    await page.type(field("battery", "rated"), "760");
    await page.type(field("battery", "measured"), "100");
    await page.select(field("battery", "ratedStandard"), "CCA");
    await page.select(field("battery", "measuredStandard"), "EN");
    assert.ok(await page.$eval(selector("battery"), e => e.textContent!.includes("Standards differ")));
    await page.select(field("battery", "measuredStandard"), "CCA");
    await page.click(`${selector("battery")} input[type="radio"]`);
    await page.type(`${selector("battery")} textarea`, "Manual tester outcome confirmed; no percentage inference.");
    await save("battery", (await snapshot("visit-one", fixture.fixture.deps)).inspection!.revision);
    await page.reload(); await page.waitForSelector(field("tire.lf", "actualSize"));
    assert.equal(await page.$eval(field("tire.lr", "actualSize"), e => (e as HTMLInputElement).value), "255/40R18");
    assert.equal(await page.$eval(field("tire.lf", "afterPsi"), e => (e as HTMLInputElement).value), "");
    await clickText("Mark internal inspection ready");
    await page.setCookie({name: "fixtureRole", value: "advisor", url: "http://127.0.0.1:24109"});
    await page.reload(); await page.waitForSelector(field("battery", "rated"));
    await clickText("Record advisor review");
    await clickText("Advisor");
    await page.waitForSelector('[aria-label="Proposed work from saved recommendations"]');
    assert.ok((await page.evaluate(() => document.body.innerText)).includes("Green · satisfactory"));
    assert.ok((await page.evaluate(() => document.body.innerText)).includes("Proposed only"));
    await page.setViewport({width: 390, height: 844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.reload();
    assert.equal(await page.$eval(field("battery", "measured"), e => (e as HTMLInputElement).value), "100");
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log("Unified DVI desktop/phone: blank measurements, green documentation, unit reset, independent pressure, battery standards, persisted reload and advisor flow passed; no external requests.");
  } finally {await browser.close(); await fixture.close();}
}
main().catch(e => {console.error(e); process.exitCode = 1;});
