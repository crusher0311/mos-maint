import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import puppeteer from "puppeteer-core";
import { createBoundedFixture } from "./bounded-loading-fixture";

test("bounded pages, debounced server scopes, bulk safety, retained refresh and stale guards", { timeout: 60000 }, async () => {
  const fixture = await createBoundedFixture();
  let releaseInitialSummary!: () => void;
  fixture.state.summaryGate = new Promise<void>(resolve => { releaseInitialSummary = resolve; });
  fixture.state.summaryDelay = 1100;
  const listen = async (s: http.Server) => {
    await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
    return (s.address() as AddressInfo).port;
  };
  const proxy = http.createServer((_req, res) => res.writeHead(403).end());
  proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  const origin = `http://127.0.0.1:${await listen(fixture.server)}`;
  const browser = await puppeteer.launch({
    executablePath: execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(), headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--proxy-server=http://127.0.0.1:${await listen(proxy)}`,
      "--proxy-bypass-list=127.0.0.1", "--disable-quic", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(String(e)));
    page.on("dialog", d => void d.accept());
    await page.setRequestInterception(true);
    page.on("request", r => { void (r.url().startsWith(origin) ? r.continue() : r.abort()); });
    page.setDefaultTimeout(10000);
    const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
    const text = () => page.evaluate(() => document.body.innerText);
    const wait = (t: string) => page.waitForFunction(s => document.body.innerText.includes(s), {}, t);
    const button = (label: string) => page.evaluate(label => {
      const b = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
      if (!b) throw new Error(`Missing button: ${label}`);
      b.click(); return b.disabled;
    }, label);
    const settled = () => page.waitForFunction(() => !document.body.innerText.includes("Refreshing shops…"));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await wait("Offline Garage 123");
    assert.equal(await page.$$eval("tbody > tr", rows => rows.length), 50);
    assert.ok((await text()).includes("Loading…"));
    assert.ok((await text()).includes("83 active · 34 in trial"));
    assert.ok((await text()).includes("Fleet updated"));
    assert.ok((await text()).includes("Approve 123 pending"));
    assert.ok((await text()).includes("Resend card-capture to 123 shops"));
    assert.ok(!fixture.state.requests.some(s => s.includes("view=history")), "history is on demand");
    fixture.state.summaryGate = null;
    releaseInitialSummary();
    await button("Resend card-capture to 123 shops");
    await wait("Resend card-capture email to 123 shops");
    await button("Send 123 emails"); await wait("Bulk card-capture results"); await button("Close");
    await settled();
    assert.equal(fixture.state.writes.at(-1)?.body.shopIds.length, 123);
    await button("Next"); await wait("Page 2 of 3");
    await wait("Offline Garage 73");
    assert.ok(!(await text()).includes("Offline Garage 123"));
    await button("Approve 123 pending");
    await wait("Approve 123 pending shops");
    await button("Approve 123");
    await settled();
    assert.equal(fixture.state.writes.at(-1)?.body.shopIds.length, 123);
    await wait("Page 2 of 3");
    const search = await page.$('input[placeholder*="Search"]');
    assert.ok(search);
    const before = fixture.state.requests.filter(s => s.includes("view=page")).length;
    fixture.state.pageDelay = 600;
    await search.type("Offline Garage 12", { delay: 10 });
    assert.equal(await button("Approve 123 pending"), true, "bulk disabled during debounce");
    await pause(150);
    assert.equal(fixture.state.requests.filter(s => s.includes("view=page")).length, before);
    await wait("Page 1 of 1");
    await wait("Showing 1–5 of 5 matching shops");
    assert.equal(await page.$$eval("tbody > tr", rows => rows.length), 5);
    assert.ok(fixture.state.requests.some(s => s.includes("search=Offline+Garage+12") && s.includes("page=1")));
    await button("Approve 5 pending");
    await button("Approve 5");
    await settled();
    assert.equal(fixture.state.writes.at(-1)?.body.shopIds.length, 5);
    // Restore a long page for a real scroll-coordinate check.
    await search.click({ clickCount: 3 }); await search.press("Backspace");
    await wait("Showing 1–50 of 123 matching shops");
    await page.evaluate(() => {
      const row = [...document.querySelectorAll("tr")].find(r => r.textContent?.includes("Offline Garage 123"));
      const expand = [...row!.querySelectorAll("button")].find(b => b.querySelector('img[alt="Tekmetric"]'));
      expand!.click();
    });
    await wait("Card-capture email history");
    assert.ok(fixture.state.requests.some(s => s.includes("view=history&shopId=123")));
    await page.evaluate(() => window.scrollTo(0, 600));
    const y = await page.evaluate(() => window.scrollY);
    await button("Refresh"); await wait("Refreshing shops…");
    assert.equal(await page.evaluate(() => window.scrollY), y);
    assert.ok((await text()).includes("Offline Garage 123"));
    assert.ok((await text()).includes("Card-capture email history"));
    await settled();
    fixture.state.fail = true;
    await button("Refresh"); await wait("Could not refresh shops");
    assert.equal(await page.evaluate(() => window.scrollY), y);
    assert.ok((await text()).includes("Offline Garage 123"));
    assert.ok((await text()).includes("Card-capture email history"));
    assert.equal(await button("Approve 123 pending"), true);
    assert.ok((await text()).includes("Showing previously loaded statistics"));
    fixture.state.fail = false; fixture.state.pageDelay = 0; fixture.state.summaryFail = true;
    fixture.state.summaryDelay = 10; fixture.state.noFleet = true;
    await button("Refresh"); await wait("Fleet statistics unavailable"); await wait("VINs viewed: Unavailable");
    assert.ok(!(await text()).includes("83 active"));
    // Old page and summary responses cannot replace the renamed core row.
    fixture.state.summaryFail = false; fixture.state.summaryDelay = 900;
    await button("Refresh"); await settled();
    await button("Rename Offline Garage 123");
    const name = await page.waitForSelector('input[placeholder="e.g. Telle Tire"]');
    await name!.click({ clickCount: 3 }); await name!.type("Offline Renamed"); await name!.press("Enter");
    await wait("Offline Renamed"); await pause(1200);
    assert.ok((await text()).includes("Offline Renamed"));
    assert.ok(!(await text()).includes("STALE SUMMARY NAME"));
    fixture.state.pageDelay = 800;
    await button("Refresh"); await pause(70);
    await search.type("Offline Garage 11");
    fixture.state.pageDelay = 0;
    await wait("Showing 1–11 of 11 matching shops"); await pause(1000);
    assert.ok(!(await text()).includes("Offline Renamed"));
    // Returning to the last committed filter during debounce still reloads.
    await search.type("temporary");
    await search.click({ clickCount: 3 }); await search.type("Offline Garage 11");
    await pause(900); await settled();
    assert.equal(await button("Approve 11 pending"), false);
    await button("Cancel");
    // Serialize all server-owned filter/sort choices, rather than filtering page rows.
    await page.evaluate(() => {
      const selects = [...document.querySelectorAll("select")];
      for (const [select, value] of selects.map((s, i) => [s, ["ending_3", "pending", "oldestStickerActivity"][i]] as const)) {
        if (value) { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }
      }
      const checkbox = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0];
      checkbox.click();
    });
    await pause(900); await settled();
    const lastPageRequest = new URL(fixture.state.requests.filter(s => s.includes("view=page")).at(-1)!, origin);
    assert.equal(lastPageRequest.searchParams.get("trialFilter"), "ending_3");
    assert.equal(lastPageRequest.searchParams.get("reviewFilter"), "pending");
    assert.equal(lastPageRequest.searchParams.get("sortBy"), "oldestStickerActivity");
    assert.equal(lastPageRequest.searchParams.get("stickerOutreachOnly"), "true");
    // Failed activity scopes must not look like a successful empty result.
    fixture.state.fail = true;
    await button("Refresh"); await wait("Could not refresh shops");
    assert.ok((await text()).includes("Offline Garage 119"));
    assert.ok(!(await text()).includes("No shops match your filters"));
    assert.equal(await button("Approve 11 pending"), true);
    // Initial failure reports unavailable statistics, not manufactured zeroes.
    await page.reload({ waitUntil: "domcontentloaded" });
    await wait("Shop list unavailable. Use Refresh to retry.");
    assert.ok((await text()).includes("Fleet statistics unavailable"));
    assert.ok(!(await text()).includes("No shops yet"));
    fixture.state.fail = false;
    await button("Refresh"); await wait("Offline Renamed");
    // Every summary is explicitly page-bounded; no core or whole-fleet summary read.
    for (const path of fixture.state.requests) {
      const url = new URL(path, origin);
      assert.notEqual(url.searchParams.get("view"), "core");
      if (url.searchParams.get("view") === "summary") {
        const ids = url.searchParams.get("shopIds");
        assert.ok(ids && ids.split(",").length <= 50);
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await Promise.all([fixture.server, proxy].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  }
});
