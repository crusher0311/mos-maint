/**
 * TEST ONLY. Browser fixture verification, no main application boot.
 * Uses a deny-all proxy, loopback-only interception and DNS restrictions.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

async function main() {
  const origin = "http://127.0.0.1:5187";
  const proxy = http.createServer((_req, res) => res.writeHead(403).end());
  proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as AddressInfo).port;
  const errors: string[] = [];
  const blockedRequests: string[] = [];
  const apiRequests: string[] = [];
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    let executablePath = process.env.HISTORY_FIXTURE_CHROMIUM;
    if (!executablePath) {
      try { executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(); }
      catch { executablePath = await chromium.executablePath(); }
    }
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [...chromium.args, `--proxy-server=http://127.0.0.1:${port}`,
        "--proxy-bypass-list=127.0.0.1", "--disable-quic", "--disable-background-networking",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (request.url().startsWith("data:")) {
        void request.continue();
      } else if (!request.url().startsWith(`${origin}/`)) {
        blockedRequests.push(request.url());
        void request.abort();
      } else {
        if (request.url().includes("/api/")) apiRequests.push(request.method());
        void request.continue();
      }
    });
    const output = "app/platform-admin/protractor-history/tests/screenshots";
    await mkdir(output, { recursive: true });
    const measurements = [];
    for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await page.goto(`${origin}/platform-admin/protractor-history`, { waitUntil: "networkidle0" });
      await page.waitForSelector("#fallback-timezone");
      await page.waitForFunction(() => document.body.textContent?.includes("Cedar Auto"));
      const layout = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        background: getComputedStyle(document.querySelector("section")!).backgroundColor,
        shops: document.querySelectorAll("li").length,
      }));
      assert.ok(layout.document <= layout.viewport, `${name} has horizontal overflow`);
      assert.equal(layout.shops, 6);
      await page.screenshot({ path: `${output}/${name}-viewport.png` });
      await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
      measurements.push({ name, ...layout });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(blockedRequests, []);
    assert.ok(apiRequests.length >= 2);
    assert.ok(apiRequests.every(method => method === "GET"), "loading must not issue writes");
    const result = { measurements, errors, blockedRequests, apiRequests };
    await writeFile(`${output}/verification.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
