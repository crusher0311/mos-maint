import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";

async function main() {
  const browser = await puppeteer.launch({
    executablePath: execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(String(e)));
    await page.setRequestInterception(true);
    page.on("request", req => req.url().startsWith("http://127.0.0.1:5115/") ? req.continue() : req.abort());
    const text = () => page.evaluate(() => document.body.innerText);
    const click = async (label: string) => page.evaluate(label => {
      const button = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === label);
      if (!button || button.disabled) throw Error(`Unavailable button ${label}`);
      button.click();
    }, label);
    await page.goto("http://127.0.0.1:5115/");
    await page.waitForSelector("#carfax-location-id");
    assert.match(await text(), /Maintenance features are not enabled/);
    for (const maintenance of [false, true]) {
      await page.evaluate(value => { (window as any).maintenanceEnabled = value; }, maintenance);
      await page.$eval("#carfax-location-id", el => { (el as HTMLInputElement).select(); });
      await page.type("#carfax-location-id", maintenance ? "ELIGIBLE" : "NO-MAINTENANCE");
      await click("Save Location ID");
      await page.waitForFunction(() => document.body.innerText.includes("Location ID saved. It has not been validated"));
      await page.reload();
      await page.waitForSelector("#carfax-location-id");
      assert.equal(await page.$eval("#carfax-location-id", el => (el as HTMLInputElement).value), maintenance ? "ELIGIBLE" : "NO-MAINTENANCE");
    }
    await page.$eval("#carfax-location-id", el => { (el as HTMLInputElement).select(); });
    await page.type("#carfax-location-id", "KEEP-DRAFT");
    for (const mode of ["network", "gateway", "json", "session", "denied"]) {
      await page.evaluate(mode => { (window as any).carfaxMode = mode; }, mode);
      await click("Save Location ID");
      await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some(b => b.textContent?.trim() === "Save Location ID" && !b.disabled));
      assert.equal(await page.$eval("#carfax-location-id", el => (el as HTMLInputElement).value), "KEEP-DRAFT");
      assert.doesNotMatch(await text(), /private|<html>/);
      assert.doesNotMatch(await text(), /Location ID saved\. It has not/);
    }
    // A failed reload preserves the draft; an explicit successful reload shows
    // what was actually persisted rather than keeping an uncertain draft.
    await click("Reload CARFAX settings");
    await page.waitForFunction(() => document.body.innerText.includes("Access denied"));
    assert.equal(await page.$eval("#carfax-location-id", el => (el as HTMLInputElement).value), "KEEP-DRAFT");
    await page.evaluate(() => { (window as any).carfaxMode = "ok"; });
    await click("Reload CARFAX settings");
    await page.waitForFunction(() => (document.querySelector("#carfax-location-id") as HTMLInputElement).value === "ELIGIBLE");
    for (const mode of ["network", "gateway", "json", "session", "denied"]) {
      await page.goto(`http://127.0.0.1:5115/?mode=${mode}`);
      await page.waitForSelector("#carfax-location-id");
      assert.doesNotMatch(await text(), /Not configured/);
      assert.equal(await page.$eval("#carfax-location-id", el => (el as HTMLInputElement).disabled), true);
      await page.evaluate(() => { (window as any).carfaxMode = "ok"; });
      await click("Reload CARFAX settings");
      await page.waitForFunction(() => !(document.querySelector("#carfax-location-id") as HTMLInputElement).disabled);
    }
    await page.goto("http://127.0.0.1:5115/dashboard/settings/carfax");
    await page.waitForSelector("#carfax-location-id");
    assert.match(page.url(), /\/dashboard\/settings\/integrations#carfax$/);
    assert.match(await text(), /Maintenance features are not enabled/);
    assert.doesNotMatch(await text(), /CARFAX is connected|Service history will appear/);
    await page.$eval("#carfax-location-id", el => { (el as HTMLInputElement).select(); });
    await page.type("#carfax-location-id", "DEDICATED-ENTRY");
    await click("Save Location ID");
    await page.waitForFunction(() => document.body.innerText.includes("Location ID saved. It has not been validated"));
    await page.reload();
    await page.waitForSelector("#carfax-location-id");
    assert.equal(await page.$eval("#carfax-location-id", el => (el as HTMLInputElement).value), "DEDICATED-ENTRY");
    assert.deepEqual(errors, []);
    console.log("CARFAX browser tests passed: saves/reloads, warnings, failure drafts, unavailable status, retry.");
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
