const assert = require("node:assert/strict");
const { chromium } = require("../../artifacts/detect-dog-workflow/node_modules/playwright");
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    let sends = 0;
    await page.route("**/*", async route => {
      if (new URL(route.request().url()).hostname !== "127.0.0.1") return route.abort();
      if (route.request().url().endsWith("/api/print/test")) sends++;
      return route.continue();
    });
    await page.goto("http://127.0.0.1:8080/dashboard/settings/printing");
    const sticker = page.locator("section").filter({ has: page.getByRole("heading", { name: "Oil stickers", exact: true }) }).first();
    await sticker.locator("select").selectOption("back");
    await sticker.getByRole("button", { name: "Save browser default", exact: true }).click();
    await page.getByText("Browser default saved for this shop.").waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("mos:printing:v1:999:sticker")), '"back"');
    assert.equal(await page.evaluate(() => localStorage.getItem("mos:printing:v1:999:keytag")), null);
    await sticker.getByRole("button", { name: "Use shop default", exact: true }).click();
    await sticker.getByRole("button", { name: "Print test label", exact: true }).click();
    await page.getByRole("button", { name: "Print calibration label", exact: true }).click();
    await page.getByText("Outcome unknown — check printer; do not automatically reprint", { exact: true }).waitFor();
    assert.equal(sends, 1);
    await page.waitForTimeout(1000);
    assert.equal(sends, 1);
    await page.getByRole("button", { name: /Close — I will check/ }).click();
    const second = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await second.newPage();
    await phone.goto("http://127.0.0.1:8080/dashboard/settings/printing");
    await phone.getByRole("heading", { name: "Printing preferences" }).waitFor();
    assert.equal(await phone.evaluate(() => localStorage.getItem("mos:printing:v1:999:sticker")), null);
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log("Saved IPP browser checks passed: defaults, device/kind isolation, calibration, unknown/no-reprint, mobile layout.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
