const { chromium } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.DEMO_CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto("http://127.0.0.1:24100/appfueled.html");
    await page.getByLabel("MOS shop ID", { exact: true }).fill("29");
    await page.getByRole("button", { name: "Load status", exact: true }).click();
    await page.getByRole("button", { name: /Configure credentials/ }).click();
    const fill = async () => {
      for (const label of ["API key", "API secret", "Connection ID"]) {
        const field = page.getByLabel(label, { exact: true });
        assert.equal(await field.getAttribute("type"), "password");
        await field.fill("offline-synthetic");
      }
    };
    await fill();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: /Configure credentials/ }).click();
    assert.equal(await page.getByLabel("API secret", { exact: true }).inputValue(), "");
    await fill();
    await page.getByRole("button", { name: "Save credentials & enable", exact: true }).click();
    await page.getByRole("button", { name: "Replace credentials", exact: true }).waitFor();
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    await page.getByRole("button", { name: "Disable connection", exact: true }).click();
    await page.getByRole("button", { name: "Confirm disable", exact: true }).click();
    await page.locator("span").filter({ hasText: /^Disabled$/ }).waitFor();
    await page.getByRole("button", { name: /Replace credentials/ }).click();
    await fill();
    await page.getByRole("button", { name: "Save credentials & enable", exact: true }).click();
    await page.getByRole("button", { name: "Disable connection", exact: true }).waitFor();
    await page.getByRole("button", { name: "Replace credentials", exact: true }).click();
    await fill();
    await page.getByLabel("MOS shop ID", { exact: true }).fill("30");
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log("AppFueled offline configure/replace/disable/clearing/mobile checks passed");
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
