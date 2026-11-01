import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import type { TireDotResult } from "@/lib/tire-dot-report-contract";

test("offline dashboard: shop-local presets, explicit/custom dates, missing zones and pinned/legacy executions", { timeout: 120_000 }, async () => {
  const bundle = await build({
    stdin: {
      contents: `import React from "react";
        import { createRoot } from "react-dom/client";
        import { TireDotDashboard } from "./app/dashboard/reporting/tire-dot-dashboard";
        const custom = new URLSearchParams(location.search).has("initial");
        createRoot(document.getElementById("root")).render(<TireDotDashboard
          scope={{ kind: "enterprise", enterpriseId: "offline" }}
          initialRange={custom ? { start: "2024-08-13", end: "2024-08-14" } : undefined} />);`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, jsx: "automatic", platform: "browser", format: "iife",
  });
  let missing = false;
  let changed = false;
  let legacy = false;
  let locationRequests = 0;
  let delayLocations = false;
  let releaseLocations: (() => void) | undefined;
  const posts: Array<{ dateBasis: string; dateRange: { start: string; end: string }; locationIds: number[] }> = [];
  const locations = () => [
    { shopId: 311, name: "Offline West", timeZone: missing ? undefined : changed ? "America/New_York" : "America/Los_Angeles" },
    { shopId: 32, name: "Offline East", timeZone: "Asia/Tokyo" },
  ];
  const makeResult = (): TireDotResult => {
    const request = posts[posts.length - 1];
    const invoices = request.locationIds.map(shopId => ({
      key: String(shopId), shopId, location: shopId === 311 ? "Offline West" : "Offline East",
      providerRoId: String(shopId), invoiceNumber: String(shopId), postedDate: "2025-01-01T00:30:00Z",
      vin: null, vehicle: null, mileage: null, partLines: 1, tireQuantity: 2, dotEntries: 1, exceptions: [],
    }));
    return {
      generatedAt: "2025-01-01T00:30:00Z", dateRange: request.dateRange, shopIds: request.locationIds,
      ...(legacy ? {} : { timeZones: { "311": "America/Los_Angeles", "32": "Asia/Tokyo" } }),
      locations: locations().filter(item => request.locationIds.includes(item.shopId)),
      details: invoices.map(({ partLines: _partLines, tireQuantity: _quantity, dotEntries: _dots, ...invoice }) => ({
        ...invoice, jobId: "1", partId: "1", entryIndex: 0, description: "Stored tire evidence", brand: null, quantity: 2, dot: "1234",
      })),
      invoices, counts: { invoices: invoices.length, partLines: invoices.length, tireQuantity: invoices.length * 2, dotEntries: invoices.length },
      coverage: { status: "stored-evidence-only", scanned: invoices.length, missingRaw: 0, missingPostedDate: 0, reasons: [] }, limited: false,
    };
  };
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url!, "http://offline.invalid").pathname;
    const json = (value: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (path === "/app.js") { res.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle.outputFiles[0].text); return; }
    if (path === "/api/reports/tire-dot/locations") {
      locationRequests++;
      if (delayLocations) await new Promise<void>(resolve => { releaseLocations = resolve; });
      json({ locations: locations() }); return;
    }
    if (path === "/api/reports/runs") {
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      posts.push(JSON.parse(body));
      json({ runId: String(posts.length), status: "succeeded", stage: "complete", result: makeResult() }); return;
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    let executablePath: string;
    try { executablePath = process.env.CHROMIUM_PATH || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(); }
    catch { executablePath = await chromium.executablePath(); }
    browser = await puppeteer.launch({
      executablePath, headless: true,
      args: [...chromium.args, "--disable-quic", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.emulateTimezone("Pacific/Kiritimati");
    await page.evaluateOnNewDocument(() => {
      const RealDate = Date;
      const instant = RealDate.parse("2025-01-01T00:30:00Z");
      // Freeze only "now"; date parsing/arithmetic still uses the native implementation.
      window.Date = class extends RealDate {
        constructor(value?: string | number) { super(value === undefined ? instant : value); }
        static now() { return instant; }
      } as DateConstructor;
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const click = (text: string) => page.evaluate(text => {
      const button = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === text);
      if (!button) throw new Error(`Missing button: ${text}`);
      button.click();
    }, text);
    const dates = () => page.$$eval('input[type="date"]', inputs => inputs.map(input => (input as HTMLInputElement).value));
    const text = () => page.evaluate(() => document.body.textContent ?? "");
    const waitForDates = (start: string, end: string) => page.waitForFunction((start, end) => {
      const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="date"]')];
      return inputs[0]?.value === start && inputs[1]?.value === end;
    }, {}, start, end);
    const refresh = async () => {
      const previous = locationRequests;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForFunction(() => !document.querySelector("fieldset")?.disabled);
      assert.ok(locationRequests > previous);
    };

    await page.goto(origin);
    await waitForDates("2024-12-02", "2024-12-31");
    assert.equal(posts.length, 0);
    assert.match(await text(), /Presets use Offline West \(America\/Los_Angeles\)/);
    await page.select("select", "7");
    await waitForDates("2024-12-25", "2024-12-31");
    // Removing the anchor location makes the remaining location's day drive the preset.
    await page.click('input[type="checkbox"]');
    await waitForDates("2024-12-26", "2025-01-01");
    await click("Select all");
    await waitForDates("2024-12-25", "2024-12-31");
    await click("Run report");
    await page.waitForSelector("tbody");
    assert.equal(posts[0].dateBasis, "shop-local");
    assert.match(await text(), /Executed results.*Shop local time/);
    assert.doesNotMatch(await text(), /Filters differ from this execution/);
    assert.deepEqual(await page.$$eval("tbody tr", rows => rows.map(row => row.querySelector("td")?.textContent)), ["2024-12-31", "2025-01-01"]);
    await click("Invoice reconciliation");
    assert.deepEqual(await page.$$eval("tbody tr", rows => rows.map(row => row.querySelector("td")?.textContent)), ["2024-12-31", "2025-01-01"]);

    changed = true;
    await refresh();
    assert.match(await text(), /Filters differ from this execution/);
    assert.match(await text(), /Offline West \(#311\) · America\/Los_Angeles/);
    assert.equal(await page.$eval("tbody tr td", td => td.textContent), "2024-12-31");
    changed = false;
    await refresh();
    legacy = true;
    await click("Run report");
    await page.waitForFunction(() => document.body.textContent?.includes("UTC (legacy execution)"));
    assert.match(await text(), /Filters differ from this execution/);
    assert.match(await page.$eval("thead", el => el.textContent ?? ""), /Posted date \(UTC\)/);
    assert.deepEqual(await page.$$eval("tbody tr", rows => rows.map(row => row.querySelector("td")?.textContent)), ["2025-01-01", "2025-01-01"]);

    await page.goto(`${origin}/?initial`);
    await page.waitForSelector('input[type="checkbox"]');
    assert.deepEqual(await dates(), ["2024-08-13", "2024-08-14"]);
    await refresh();
    assert.deepEqual(await dates(), ["2024-08-13", "2024-08-14"]);
    missing = true;
    await refresh();
    assert.match(await text(), /A valid timezone is missing for Offline West/);
    assert.equal(await page.$eval('button[type="submit"]', button => (button as HTMLButtonElement).disabled), true);
    const before = posts.length;
    await click("Run report");
    assert.equal(posts.length, before);
    assert.deepEqual(await dates(), ["2024-08-13", "2024-08-14"]);
    missing = false;
    await refresh();
    assert.deepEqual(await dates(), ["2024-08-13", "2024-08-14"]);

    // Inputs remain editable while the initial locations request is in flight.
    delayLocations = true;
    await page.goto(origin);
    await page.waitForSelector('input[type="date"]');
    await page.$eval('input[type="date"]', input => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "2024-09-17");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    while (!releaseLocations) await new Promise(resolve => setTimeout(resolve, 10));
    delayLocations = false;
    releaseLocations();
    await page.waitForSelector('input[type="checkbox"]');
    assert.deepEqual(await dates(), ["2024-09-17", ""]);
    await refresh();
    assert.deepEqual(await dates(), ["2024-09-17", ""]);
    assert.deepEqual(errors, []);
  } finally {
    releaseLocations?.();
    await browser?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
