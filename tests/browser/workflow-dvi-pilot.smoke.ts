import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import puppeteer from "puppeteer-core";
import {createPilotBrowserFixture} from "./workflow-dvi-pilot-fixture-server";
async function main() {
  const fixture = await createPilotBrowserFixture();
  await new Promise<void>(resolve => fixture.server.listen(24109, "127.0.0.1", resolve));
  const browser = await puppeteer.launch({executablePath: execFileSync("which", ["chromium"], {encoding: "utf8"}).trim(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"]});
  try {
    const page = await browser.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("dialog", dialog => void dialog.accept());
    page.setDefaultTimeout(15000);
    await page.goto("http://127.0.0.1:24109/");
    async function click(text: string) {
      await page.waitForFunction(text => [...document.querySelectorAll("button")].some(b => b.textContent?.includes(text) && !b.disabled), {}, text);
      await page.evaluate(text => ([...document.querySelectorAll("button")].find(b => b.textContent?.includes(text)) as HTMLButtonElement).click(), text);
    }
    await page.waitForSelector('input[type="checkbox"]');
    await page.click('input[type="checkbox"]');
    fixture.loseNext("preview");
    await click("Preview selected saved findings");
    await page.waitForFunction(() => !!document.querySelector('[role="alert"]') && document.body.innerText.includes("Pending · do not resend"));
    await page.reload();
    await page.waitForFunction(() => document.body.innerText.includes("Frozen preview"));
    assert.equal(fixture.sends, 0);
    await page.evaluate(() => {
      const label = [...document.querySelectorAll("label")].find(l => l.textContent?.includes("I reviewed this frozen preview"));
      (label?.querySelector("input") as HTMLInputElement).click();
    });
    fixture.loseNext("send");
    await click("Send saved findings");
    await page.waitForFunction(() => !!document.querySelector('[role="alert"]') && document.body.innerText.includes("Pending · do not resend"));
    await page.reload();
    await page.waitForFunction(() => document.body.innerText.includes("Confirmed · exact readback"));
    assert.equal(fixture.sends, 1);
    await click("Reconcile existing operation");
    await page.waitForFunction(() => document.body.innerText.includes("Confirmed · exact readback"));
    assert.equal(fixture.sends, 1);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].some(b => b.textContent === "Send saved findings")), false);
    assert.deepEqual(errors, []);
    console.log("PASS persistent preview → lost response → reload → explicit send → lost response → exact readback → read-only reconcile; one native send");
  } finally {await browser.close(); await fixture.close();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
