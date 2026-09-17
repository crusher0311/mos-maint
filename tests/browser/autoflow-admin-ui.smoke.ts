/**
 * Real-component browser verification for Task #1287.
 *
 * Run the fixture server first:
 *   npx tsx tests/browser/autoflow-admin-fixture-server.ts
 * Then run this file. It uses only the local fixture server and Chromium.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";

const port = Number(process.env.AUTOFLOW_FIXTURE_PORT || 5100);
const base = `http://127.0.0.1:${port}`;
const chromium = process.env.CHROMIUM_PATH || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
fs.mkdirSync("screenshots", { recursive: true });

async function main() {
const browser = await puppeteer.launch({
  executablePath: chromium,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
page.setDefaultTimeout(10000);
const calls: Array<{ url: string; method: string; body?: string }> = [];
const bodyText = () => page.evaluate(() => document.body.innerText);
async function selectByOptionText(optionText: string, value: string, occurrence = 0) {
  await page.evaluate(({ optionText, value, occurrence }) => {
    const matches = [...document.querySelectorAll("select")].filter((select) =>
      [...select.options].some((option) => option.textContent?.includes(optionText)),
    ) as HTMLSelectElement[];
    const index = occurrence < 0 ? matches.length + occurrence : occurrence;
    const select = matches[index];
    if (!select) throw new Error(`No select containing option ${optionText}`);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, { optionText, value, occurrence });
}
async function selectRow(rowText: string, value: string) {
  await page.evaluate(({ rowText, value }) => {
    const row = [...document.querySelectorAll("tr")].find((item) =>
      item.querySelector("td")?.textContent?.trim() === rowText,
    );
    const select = row?.querySelector("select") as HTMLSelectElement | null;
    if (!select) throw new Error(`No workflow row containing ${rowText}`);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, { rowText, value });
}
async function clickButton(buttonText: string) {
  await page.evaluate((buttonText) => {
    const button = [...document.querySelectorAll("button")].find((item) =>
      item.textContent?.replace(/\s+/g, " ").includes(buttonText),
    ) as HTMLButtonElement | undefined;
    if (!button) throw new Error(`No button containing ${buttonText}`);
    button.click();
  }, buttonText);
}
page.on("request", (request) => {
  if (request.url().includes("/api/")) calls.push({
    url: request.url(),
    method: request.method(),
    body: request.postData(),
  });
});

await fetch(`${base}/__fixture__/reset`, { method: "POST" });
await page.goto(base, { waitUntil: "networkidle0" });
await page.waitForFunction(() => document.body.innerText.includes("AutoFlow v4 Shop Numbers"));
assert.match(await bodyText(), /Unresolved numbers/);
assert.match(await bodyText(), /No unresolved AutoFlow numbers/);
assert.match(await bodyText(), /Provider number — not the internal MOS ID/);
await page.screenshot({ path: "screenshots/autoflow-admin.jpg", fullPage: true });

// Manual attach must preserve provider number 615 and internal MOS ID 432.
await page.locator('input[placeholder="Digits only, up to 64"]').fill("615");
await selectByOptionText("Grand Rapids", "432", 0);
page.once("dialog", (dialog) => dialog.accept());
await clickButton("Attach number");
await page.waitForFunction(() => document.body.innerText.includes("Attached 615"));
assert.ok(calls.some((call) =>
  call.method === "POST" && call.url.endsWith("/api/platform-admin/autoflow-numbers") &&
  call.body?.includes('"number":"615"') && call.body?.includes('"shopId":"432"'),
));
await page.waitForFunction(() => document.body.innerText.includes("Current mappings (1 shops)"));
assert.match(await bodyText(), /615/);

// Workflow editor: slow 432 details must not overwrite fast 901 details.
await selectByOptionText("Grand Rapids", "432", -1);
await selectByOptionText("Grand Rapids", "901", -1);
await page.waitForFunction(() => document.body.innerText.includes("Lansing Active"));
await new Promise((resolve) => setTimeout(resolve, 700));
assert.doesNotMatch(await bodyText(), /Needs Review/);

await selectByOptionText("Grand Rapids", "432", -1);
await page.waitForFunction(() => document.body.innerText.includes("Needs Review"));
await selectRow("Needs Review", "active");
await selectRow("CHECKED IN", "active");
await selectRow("Appointment", "excluded");
await selectRow("Close", "closed");
assert.match(await bodyText(), /Saved Active/);
await clickButton("Save mapping");
await page.waitForFunction(() => document.body.innerText.includes("Workflow mapping saved"));
const savedCall = calls.findLast(call => call.method === "PUT");
const savedRules = JSON.parse(savedCall?.body || "{}").mapping;
assert.deepEqual(savedRules.closed, ["Close"]);
assert.deepEqual(savedRules.excluded, ["Appointment"]);
assert.ok(savedRules.active.includes("Needs Review") && savedRules.active.includes("CHECKED IN"));
assert.match(await bodyText(), /existing events will be reevaluated/i);
await page.screenshot({ path: "screenshots/autoflow-workflow.jpg", fullPage: true });
page.once("dialog", (dialog) => dialog.accept());
await clickButton("Reset");
await page.waitForFunction(() => document.body.innerText.includes("mapping reset"));

// A failed detail request must not allow another shop's mapping to be saved.
await selectByOptionText("Grand Rapids", "902", -1);
await page.waitForFunction(() => document.body.innerText.includes("Fixture detail load failed"));
assert.equal(await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find(item => item.textContent?.includes("Save mapping"));
  return !button || button.disabled;
}), true);
assert.doesNotMatch(await bodyText(), /Needs Review/);

console.log("✓ Task1287 offline browser UI verification passed");
console.log("  screenshots/autoflow-admin.jpg");
console.log("  screenshots/autoflow-workflow.jpg");
} finally {
  await browser.close();
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});