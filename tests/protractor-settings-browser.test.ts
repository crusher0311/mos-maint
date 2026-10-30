import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import {
  createProtractorSettingsFixture, pendingMessage, restrictedMessage,
  rejectedMessage, unavailableMessage,
} from "./browser/protractor-settings-fixture-server";

test("authenticated Protractor settings: connect, reload, retained failure and restricted sync", { timeout: 60000 }, async () => {
  const fixture = await createProtractorSettingsFixture();
  const proxy = http.createServer((_req, res) => res.writeHead(403).end());
  proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  const listen = async (server: http.Server) => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  };
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    const origin = `http://127.0.0.1:${await listen(fixture.server)}`;
    const proxyPort = await listen(proxy);
    let executablePath: string;
    try { executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(); }
    catch { executablePath = await chromium.executablePath(); }
    browser = await puppeteer.launch({ executablePath, headless: true, args: [
      ...chromium.args, `--proxy-server=http://127.0.0.1:${proxyPort}`,
      "--proxy-bypass-list=127.0.0.1", "--disable-quic",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ] });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    const external: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (!request.url().startsWith(`${origin}/`)) {
        external.push(request.url()); void request.abort();
      } else void request.continue();
    });
    assert.equal((await fetch(`${origin}/api/settings/protractor`)).status, 401);
    await browser.setCookie({ name: "offline-session", value: "fixture-shop",
      domain: "127.0.0.1", path: "/", httpOnly: true });
    const text = () => page.evaluate(() => document.body.innerText);
    const waitText = async (value: string) => {
      try {
        await page.waitForFunction(value => document.body.innerText.includes(value), {}, value);
      } catch {
        assert.fail(`Missing ${value}\nRendered: ${await text()}\nErrors: ${errors}\nRequests: ${JSON.stringify(fixture.calls)}`);
      }
    };
    const click = async (label: string) => {
      const buttons = await page.$$("div.space-y-3.border-t button");
      for (const button of buttons) {
        if (await button.evaluate(el => el.textContent?.trim()) === label) {
          await button.click();
          return;
        }
      }
      assert.fail(`Missing button: ${label}`);
    };
    const writes = () => fixture.calls.filter(call => call.method !== "GET");
    const noFalseSuccess = async () => assert.doesNotMatch(await text(),
      /Synced \d+ vehicles|Initial sync done|Syncing your first vehicles/);
    for (const scenario of ["pending", "failed", "rejected", "unavailable"] as const) {
      fixture.reset(scenario);
      await page.goto(`${origin}/dashboard/settings/integrations`, { waitUntil: "networkidle0" });
      await page.locator('input[placeholder="Your Protractor Connection ID"]').fill("offline-connection");
      await page.locator('input[placeholder="Your Protractor API Key"]').fill("offline-key");
      await click("Connect");
      if (scenario === "rejected" || scenario === "unavailable") {
        await waitText(scenario === "rejected" ? rejectedMessage : unavailableMessage);
        assert.doesNotMatch(await text(), /Connected to Protractor|Protractor connected|connection is saved/);
        assert.deepEqual(fixture.snapshot(), { configured: false });
        await noFalseSuccess();
        await page.reload({ waitUntil: "networkidle0" });
        await page.waitForSelector('input[placeholder="Your Protractor Connection ID"]');
        assert.doesNotMatch(await text(), /Connected to Protractor/);
      } else {
        await waitText("Protractor connected. Historical imports require separate approval; saved sync progress is unchanged.");
        const statusMessage = scenario === "pending" ? pendingMessage :
          "Historical sync needs attention: Previous import interrupted. Existing progress is retained; an approved import is required to resume.";
        await waitText(statusMessage);
        await noFalseSuccess();
        assert.equal(writes().length, 1, "Connect must not issue bulk sync or other writes");
        const saved = fixture.snapshot();
        await page.reload({ waitUntil: "networkidle0" });
        await waitText(statusMessage);
        await waitText("Connected to Protractor");
        assert.equal(await page.$eval('input[readonly]', el => (el as HTMLInputElement).value),
          "https://mos.tools/api/webhooks/protractor/offline-callback");
        await noFalseSuccess();
        assert.equal(writes().length, 1, "reload must not start an import");
        await click("Sync Now");
        await waitText(restrictedMessage);
        await waitText(statusMessage);
        await noFalseSuccess();
        assert.deepEqual(fixture.snapshot(), saved, "denial leaves saved connection and progress unchanged");
        assert.deepEqual(writes().slice(1).map(call => [call.method, call.path]), [["POST", "/api/protractor/sync"]]);
        await page.reload({ waitUntil: "networkidle0" });
        await waitText(statusMessage);
        assert.deepEqual(fixture.snapshot(), saved);
      }
      assert.deepEqual(writes()[0], {
        method: "POST", path: "/api/settings/protractor",
        body: { connectionId: "offline-connection", apiKey: "offline-key" },
      });
      assert.equal(writes().length, scenario === "pending" || scenario === "failed" ? 2 : 1);
    }
    fixture.reset("pending");
    fixture.failStatus(true);
    await page.goto(`${origin}/dashboard/settings/integrations`, { waitUntil: "domcontentloaded" });
    await waitText("Connection status could not be confirmed.");
    assert.equal(await page.$('input[placeholder="Your Protractor API Key"]'), null);
    fixture.failStatus(false);
    await click("Retry status");
    await page.waitForSelector('input[placeholder="Your Protractor API Key"]');
    fixture.failRefreshAfterSave();
    await page.locator('input[placeholder="Your Protractor Connection ID"]').fill("offline-connection");
    await page.locator('input[placeholder="Your Protractor API Key"]').fill("offline-key");
    await click("Connect");
    await waitText("Protractor connected. Historical imports require separate approval; saved sync progress is unchanged.");
    await waitText("Showing the last saved connection.");
    await waitText("Connected to Protractor");
    assert.equal(await page.$('input[placeholder="Your Protractor API Key"]'), null);
    assert.equal(writes().length, 1);
    fixture.failStatus(false);
    await click("Retry status");
    await page.waitForFunction(() => !document.body.innerText.includes("Protractor status is temporarily unavailable"));
    await waitText("Connected to Protractor");
    await page.reload({ waitUntil: "networkidle0" });
    await waitText("Connected to Protractor");
    page.once("dialog", dialog => void dialog.accept());
    await page.$eval("div.space-y-3.border-t button.bg-red-100", el => (el as HTMLButtonElement).click());
    await waitText("Disconnected");
    await page.waitForSelector('input[placeholder="Your Protractor API Key"]');
    assert.equal(fixture.snapshot().configured, false);
    assert.deepEqual(fixture.unexpected, []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await Promise.all([fixture.server, proxy].map(server => new Promise<void>(resolve => {
      server.close(() => resolve()); server.closeAllConnections();
    })));
  }
});
