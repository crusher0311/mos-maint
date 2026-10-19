import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { createHistoryFixture, summary } from "./browser/terminal-history-fixture-server";

test("real history component: loading, repeated refresh, denied/unavailable, and recovery", { timeout: 60000 }, async () => {
  const pending: http.ServerResponse[] = [];
  // Responses change in asynchronous handlers; observe a fresh count after awaits.
  const pendingCount = () => pending.length;
  const requests: string[] = [];
  const fixture = await createHistoryFixture((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    pending.push(res);
  });
  const proxy = http.createServer((_req, res) => res.writeHead(403).end());
  proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  const listen = async (server: http.Server) => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  };
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    const port = await listen(fixture);
    const proxyPort = await listen(proxy);
    const origin = `http://127.0.0.1:${port}`;
    let executablePath: string;
    try { executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(); }
    catch { executablePath = await chromium.executablePath(); }
    browser = await puppeteer.launch({
      executablePath, headless: true,
      args: [...chromium.args, `--proxy-server=http://127.0.0.1:${proxyPort}`,
        "--proxy-bypass-list=127.0.0.1", "--disable-quic", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    const unexpected: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (!request.url().startsWith(`${origin}/`)) {
        unexpected.push(request.url()); void request.abort();
      } else void request.continue();
    });
    await page.goto(origin);
    await page.waitForSelector("section button");
    assert.equal(requests.length, 0, "nothing loads until requested");
    const noCounts = async () => {
      assert.equal(await page.$$eval("article", nodes => nodes.length), 0);
      assert.doesNotMatch(await page.$eval("section", el => el.textContent!), /Imported:|Verified present:|receipts on this page|No terminal history campaigns/);
    };
    await noCounts();
    const start = async () => {
      const before = requests.length;
      await page.click("section button");
      await page.waitForFunction(() => (document.querySelector("section button") as HTMLButtonElement)?.disabled);
      assert.equal(await page.$eval("section button", el => el.textContent), "Loading summary…");
      await noCounts();
      assert.equal(await page.$$eval("[role=alert]", nodes => nodes.length), 0);
      // A disabled button cannot dispatch a second fetch while the first is pending.
      await page.click("section button");
      for (let i = 0; pending.length === 0 && i < 100; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(pending.length, 1);
      assert.equal(requests.length, before + 1);
    };
    const finish = async (status: number, body: unknown) => {
      pending.shift()!.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      await page.waitForFunction(() => !(document.querySelector("section button") as HTMLButtonElement)?.disabled);
      assert.equal(await page.$eval("section button", el => el.textContent), "Load / refresh newest campaigns");
    };
    const success = async (count: number) => {
      await start(); await finish(200, summary(count));
      assert.match(await page.$eval("article", el => el.textContent!), new RegExp(`Imported: ${count} · Verified present: 34`));
      assert.equal(await page.$$eval("[role=alert]", nodes => nodes.length), 0);
    };
    await success(120);
    await success(241);
    for (const status of [401, 503]) {
      await start(); await finish(status, { error: status === 401 ? "Unauthorized" : "Unavailable" });
      await page.waitForSelector("[role=alert]");
      assert.equal(await page.$eval("[role=alert]", el => el.textContent),
        "History import summary unavailable. No import state was changed. Try refreshing.");
      await noCounts();
      await success(status + 100);
    }
    await start(); await finish(200, { ...summary(), campaigns: [] });
    assert.match(await page.$eval("section", el => el.textContent!), /No terminal history campaigns found/);
    assert.equal(await page.$$eval("[role=alert]", nodes => nodes.length), 0);
    assert.equal(requests.length, 7);
    assert.ok(requests.every(r => r === "GET /api/platform-admin/terminal-history-imports?"));
    // Preserve the incoming pagination behavior while applying the same failure
    // contract: a targeted page replaces only its campaign, never its siblings.
    await start();
    const paginated = summary(700);
    paginated.campaigns[0].nextReceiptCursor = "fixture-receipts";
    paginated.campaigns[0].receiptsTruncated = true;
    paginated.campaigns.push({ ...summary(800).campaigns[0], campaignId: "sibling-campaign" });
    await finish(200, paginated);
    await page.evaluate(() => {
      [...document.querySelectorAll("button")].find(b => b.textContent === "Next receipts")!.click();
    });
    await page.waitForFunction(() => (document.querySelector("section button") as HTMLButtonElement).disabled);
    await noCounts();
    for (let i = 0; pendingCount() === 0 && i < 100; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(pending.length, 1);
    assert.equal(requests.at(-1),
      "GET /api/platform-admin/terminal-history-imports?campaignId=example-history-campaign&receiptAfter=fixture-receipts");
    const nextPage = summary(900);
    nextPage.campaigns[0].receiptAfter = "fixture-receipts";
    await finish(200, nextPage);
    assert.equal(await page.$$eval("article", nodes => nodes.length), 2);
    const pageText = await page.$eval("section", el => el.textContent!);
    assert.match(pageText, /Imported: 900/);
    assert.match(pageText, /Imported: 800/);
    assert.doesNotMatch(pageText, /Imported: 700/);
    assert.match(pageText, /Earlier receipt pages are excluded/);
    await page.evaluate(() => {
      [...document.querySelectorAll("button")].find(b => b.textContent === "First receipt page")!.click();
    });
    await page.waitForFunction(() => (document.querySelector("section button") as HTMLButtonElement).disabled);
    for (let i = 0; pendingCount() === 0 && i < 100; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(pending.length, 1);
    await finish(503, { error: "Unavailable" });
    await page.waitForSelector("[role=alert]");
    await noCounts();
    await success(1000);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  } finally {
    pending.forEach(res => res.destroy());
    await browser?.close();
    await Promise.all([fixture, proxy].map(server => new Promise<void>(resolve => {
      server.closeAllConnections(); server.close(() => resolve());
    })));
  }
});
