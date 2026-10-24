import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import puppeteer from "puppeteer-core";
import { createShopsFixture } from "./browser/platform-shops-fixture-server";

test("large fleet stays searchable during hydration, refresh and failure; newer edits win", { timeout: 60000 }, async () => {
  const fixture = await createShopsFixture();
  let releaseSummary!: () => void;
  fixture.state.summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
  const proxy = http.createServer((_req, res) => res.writeHead(403).end());
  proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  const listen = async (s: http.Server) => {
    await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
    return (s.address() as AddressInfo).port;
  };
  const origin = `http://127.0.0.1:${await listen(fixture.server)}`;
  const browser = await puppeteer.launch({
    executablePath: execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage",
      `--proxy-server=http://127.0.0.1:${await listen(proxy)}`, "--proxy-bypass-list=127.0.0.1",
      "--disable-quic", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(String(e)));
    page.on("dialog", d => void d.accept());
    await page.setRequestInterception(true);
    page.on("request", r => { void (r.url().startsWith(origin) ? r.continue() : r.abort()); });
    page.setDefaultTimeout(10000);
    const wait = (text: string) => page.waitForFunction(t => document.body.innerText.includes(t), {}, text);
    const click = async (text: string) => {
      const found = await page.evaluate(t => {
        const b = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === t || b.getAttribute("aria-label") === t);
        b?.click(); return !!b;
      }, text);
      assert.ok(found, `Button ${text} exists`);
    };
    const start = performance.now();
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await wait("Fixture Shop 1000");
    console.log("ISOLATED_BROWSER_USABLE_MS", Math.round(performance.now() - start));
    assert.ok((await page.evaluate(() => document.body.innerText)).includes("Loading…"));
    releaseSummary();
    fixture.state.summaryGate = null;
    fixture.state.summaryDelay = 10;
    const search = await page.$('input[placeholder*="Search"]');
    assert.ok(search);
    await search.type("Fixture Shop 1");
    await wait("Fixture Shop 1000");
    assert.ok(!await page.evaluate(() => document.body.innerText.includes("Fixture Shop 999")));
    // Expand a row; the history request is not part of either list response.
    await page.evaluate(() => {
      const row = [...document.querySelectorAll("tr")].find(r => r.textContent?.includes("Fixture Shop 1"));
      const expand = [...row!.querySelectorAll("button")].find(b => b.querySelector('img[alt="Tekmetric"]'));
      expand?.click();
    });
    await wait("Card-capture email history");
    fixture.state.coreDelay = 700;
    await page.evaluate(() => window.scrollTo(0, 500));
    const scroll = await page.evaluate(() => window.scrollY);
    await click("Refresh");
    await wait("Refreshing shops…");
    assert.ok(await page.evaluate(() => document.body.innerText.includes("Fixture Shop 1000")));
    assert.equal(await page.evaluate(() => window.scrollY), scroll);
    await page.waitForFunction(() => !document.body.innerText.includes("Refreshing shops…"));
    assert.equal(await search.evaluate(e => (e as HTMLInputElement).value), "Fixture Shop 1");
    await wait("Card-capture email history");
    fixture.state.coreFail = true;
    await click("Refresh");
    await wait("Could not refresh shops");
    assert.ok(await page.evaluate(() => document.body.innerText.includes("Fixture Shop 1000")));
    fixture.state.coreFail = false;
    fixture.state.summaryFail = true;
    fixture.state.summaryDelay = 10;
    fixture.state.coreDelay = 0;
    await click("Refresh");
    await wait("Unavailable");
    // A late old core response cannot replace a new server edit.
    fixture.state.coreDelay = 700;
    await click("Refresh");
    await new Promise(r => setTimeout(r, 100));
    fixture.api.f.shops = fixture.api.f.shops.map(s => s.shopId === 1 ? { ...s, name: "Fixture Shop 1 Renamed" } : s);
    fixture.state.coreDelay = 0;
    await click("Refresh");
    await wait("Fixture Shop 1 Renamed");
    await new Promise(r => setTimeout(r, 900));
    assert.ok(await page.evaluate(() => document.body.innerText.includes("Fixture Shop 1 Renamed")));
    await click("Rename Fixture Shop 1 Renamed");
    const name = await page.waitForSelector('input[placeholder="e.g. Telle Tire"]');
    await name!.click({ clickCount: 3 });
    await name!.type("Fixture Shop 1 Saved");
    await name!.press("Enter");
    await wait("Fixture Shop 1 Saved");
    assert.equal(fixture.api.f.shops[0].name, "Fixture Shop 1 Saved");
    assert.deepEqual(errors, []);
  } finally {
    releaseSummary();
    await browser.close();
    await Promise.all([fixture.server, proxy].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  }
});
