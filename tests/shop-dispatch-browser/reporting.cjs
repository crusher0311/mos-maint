const { chromium } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.DEMO_CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://127.0.0.1:24100/reporting.html");
    await page.getByRole("status").filter({ hasText: "Support reference: fixture-run-1" }).waitFor();
    await page.getByText("Saved report · version 1").waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Report name" }).inputValue(), "Pinned Hours Presented");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Required reporting database setup" }).waitFor();
    await page.getByLabel("Saved reports").selectOption("second");
    assert.equal(await page.getByText(/Support reference:/).count(), 0, "previous failure is cleared on selection");
    await page.getByLabel("Saved reports").selectOption("first");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByLabel("Saved reports").selectOption("second");
    await page.waitForTimeout(2200);
    assert.equal(await page.getByText(/Support reference:/).count(), 0, "late polling cannot overwrite the selected report");
    assert.deepEqual(errors, []);
    console.log("Reporting reopen, pinned version, refresh and selection isolation: PASS");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
