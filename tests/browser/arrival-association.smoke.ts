import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import puppeteer from "puppeteer-core";
import {createStaffBrowserFixture} from "./staff-inspection-fixture-server";

async function main() {
  const fixture = await createStaffBrowserFixture(false, true);
  await fixture.fixture.initialize();
  await new Promise<void>(resolve => fixture.server.listen(24126, "127.0.0.1", resolve));
  const browser = await puppeteer.launch({executablePath: execFileSync("which", ["chromium"], {encoding: "utf8"}).trim(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"]});
  try {
    const page = await browser.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto("http://127.0.0.1:24126/");
    await page.waitForSelector("article");
    await page.click('[data-testid="arrival-photo-documentation"] summary');
    const button = '[data-testid="arrival-photo-documentation"] button';
    assert.equal(await page.$eval(button, el => (el as HTMLButtonElement).disabled), true);
    await page.click('article input[type="radio"]');
    await page.type("article textarea", "Evaluated tire condition independently of arrival photo.");
    await page.click('article button[type="submit"]');
    await page.waitForFunction(() => document.body.innerText.includes("Saved — server receipt"));
    await page.select('select[aria-label="Arrival photo checklist item"]', JSON.stringify(["fixture@1","tire.lf"]));
    await page.click(button);
    await page.waitForFunction(() => document.querySelector("article")?.textContent?.includes("Associated arrival documentation · 1"));
    assert.equal(await page.$eval(button, el => (el as HTMLButtonElement).disabled), true);
    await page.reload();
    await page.waitForSelector("article img");
    const url = await page.$eval("article img", el => el.getAttribute("src")!);
    assert.equal((await page.goto(`http://127.0.0.1:24126${url}`))!.status(), 200);
    assert.equal(await fixture.fixture.db.collection("guided_ro_arrival_photos").countDocuments(), 1);
    assert.ok(!fixture.calls.some(c => c === "POST /api/shop-dispatch/inspection/media"));
    assert.deepEqual(errors, []);
    console.log("PASS saved evaluation → explicit association → disabled duplicate → reload → original photo; no upload");
  } finally {await browser.close(); await fixture.close();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
