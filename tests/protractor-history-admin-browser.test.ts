import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { historyAdminFixture } from "./browser/protractor-history-admin-fixture-server";

test("admin saves, reloads and removes shop hours while worker activation stays blocked", { timeout: 90000 }, async () => {
  const f = await historyAdminFixture();
  const proxy = http.createServer((_req, res) => res.writeHead(403).end());
  proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  const listen = async (server: http.Server) => {
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  };
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    const origin = `http://127.0.0.1:${await listen(f.server)}`;
    const proxyPort = await listen(proxy);
    let executablePath: string;
    try { executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(); }
    catch { executablePath = await chromium.executablePath(); }
    browser = await puppeteer.launch({ executablePath, headless: true, args: [
      ...chromium.args, `--proxy-server=http://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=127.0.0.1",
      "--disable-quic", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ] });
    const page = await browser.newPage();
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(String(e)));
    await page.setRequestInterception(true);
    page.on("request", r => { void (r.url().startsWith(origin + "/") ? r.continue() : r.abort()); });
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(origin);
    await page.waitForFunction(() => document.body.innerText.includes("No worker heartbeat"));
    assert.equal(f.calls.length, 0, "loading must never write");
    const check = async (label: string) => page.evaluate(label => {
      const input = [...document.querySelectorAll("label")].find(l => l.textContent?.includes(label))?.querySelector("input");
      if (!input) throw new Error("Missing checkbox " + label);
      input.click();
    }, label);
    const save = async () => {
      await check("I confirm the seven-day");
      await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent === "Save configuration")!.click());
      await page.waitForFunction(() => document.body.innerText.includes("Configuration saved"));
    };
    await page.click("summary");
    await check("Use shop-specific scheduling");
    await page.$eval('input[aria-label="Fictional South Kansas City Shop Monday opens"]', input => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "07:00"); input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await save();
    assert.equal(f.config().enabled, false);
    assert.equal(f.config().shopSchedules?.[0].week[1].open, "07:00");
    assert.equal(f.config().shopSchedules?.[0].timezone, null);
    await page.reload();
    await page.waitForFunction(() => document.body.innerText.includes("America/Chicago"));
    assert.match(await page.evaluate(() => document.body.innerText), /Protractor location/);
    await page.click("summary");
    assert.equal(await page.$eval('input[aria-label="Fictional South Kansas City Shop Monday opens"]', e => (e as HTMLInputElement).value), "07:00");
    page.on("dialog", d => { void d.accept(); });
    await check("Use shop-specific scheduling");
    await save();
    assert.deepEqual(f.config().shopSchedules, []);
    await check("Enable historical sync");
    await check("I confirm the seven-day");
    await check("I confirm enabling or expanding");
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent === "Save configuration")!.disabled), true);
    assert.equal(f.calls.length, 2, "blocked activation must not submit");
    await page.setViewport({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await Promise.all([f.server, proxy].map(s => new Promise<void>(r => s.close(() => r()))));
  }
});
