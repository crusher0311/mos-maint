import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { createTireFixture } from "./browser/tire-dot-fixture-server";

test("self-service flow: no auto-run, filters, polling, exceptions, invoices, pagination, CSV, revocation and empty/error states", { timeout: 120_000 }, async () => {
  const server = await createTireFixture();
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let browser;
  try {
    let executablePath: string;
    try { executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(); }
    catch { executablePath = await chromium.executablePath(); }
    browser = await puppeteer.launch({ executablePath, headless: true, args: [...chromium.args, "--disable-quic", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
    const page = await browser.newPage();
    const errors: string[] = []; page.on("pageerror", e => errors.push(String(e)));
    await page.goto(origin); await page.waitForSelector('input[type="checkbox"]');
    const stats = async () => (await fetch(`${origin}/fixture/stats`)).json();
    const click = async (text: string) => page.evaluate(text => {
      const b = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
      if (!b) throw new Error("Button not found: " + text); b.click();
    }, text);
    assert.equal((await stats()).posts, 0);
    await page.select("select", "7"); assert.equal((await stats()).posts, 0);
    await click("Run report");
    await page.waitForFunction(() => document.body.textContent?.includes("Executed results"), { timeout: 15000 });
    assert.equal((await stats()).posts, 1);
    assert.ok((await stats()).polls >= 2);
    assert.match(await page.evaluate(() => document.body.textContent), /Stale result/);
    await click("Next");
    assert.match(await page.evaluate(() => document.body.textContent), /Page 2 of/);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find(b => b.textContent?.includes("Exceptions")); b?.click();
    });
    await page.waitForFunction(() => document.querySelector("tbody")?.textContent?.includes("Missing invoice mileage"));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find(b => b.textContent?.includes("Invoice reconciliation")); b?.click();
    });
    await page.waitForFunction(() => document.querySelector("table caption")?.textContent?.includes("Invoice reconciliation"));
    assert.equal(await page.$$eval("tbody tr", rows => rows.length), 50);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find(b => b.textContent?.includes("Invoice CSV")); b?.click();
    });
    await page.waitForFunction(() => !document.body.textContent?.includes("Preparing CSV"));
    await new Promise(r => setTimeout(r, 100));
    assert.equal((await stats()).downloads, 1);
    const csv = await (await fetch(`${origin}/api/reports/export?view=invoices`)).text();
    assert.equal(csv.split("\r\n").filter(Boolean).length, 53);
    await fetch(`${origin}/fixture/control?deny=true`);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => !document.body.textContent?.includes("Executed results"));
    assert.equal(await page.$("tbody"), null);
    await fetch(`${origin}/fixture/control?mode=empty`);
    await page.reload(); await page.waitForSelector('input[type="checkbox"]'); await click("Run report");
    await page.waitForFunction(() => document.body.textContent?.includes("Executed results"), { timeout: 15000 });
    assert.equal(await page.$("tbody"), null);
    assert.match(await page.evaluate(() => document.body.textContent), /not all upstream sales/);
    await fetch(`${origin}/fixture/control?mode=failed`); await click("Run report");
    await page.waitForFunction(() => document.body.textContent?.includes("Fixture extraction failed"), { timeout: 10000 });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await new Promise<void>(r => server.close(() => r()));
  }
});
