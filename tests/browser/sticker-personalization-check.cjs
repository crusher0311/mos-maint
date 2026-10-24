const { chromium, expect } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const { execFileSync } = require("node:child_process");
(async () => {
  const browser = await chromium.launch({ executablePath: execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(), headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.goto("http://127.0.0.1:8099/");
    await page.getByText("Sticker Options", { exact: true }).click();
    const name = page.getByRole("checkbox", { name: "Thank customer by name (extension only)" });
    const open = page.getByRole("checkbox", { name: "Orange button opens Print tab first" });
    await expect(name).not.toBeChecked();
    await expect(open).not.toBeChecked();
    await name.check();
    await page.waitForResponse(r => r.url().endsWith("/api/sticker/settings") && r.request().method() === "PUT");
    await page.reload();
    await page.getByText("Sticker Options", { exact: true }).click();
    await expect(name).toBeChecked();
    await expect(open).not.toBeChecked();
    await open.check();
    await page.waitForResponse(r => r.url().endsWith("/api/sticker/settings") && r.request().method() === "PUT");
    await page.reload();
    await page.getByText("Sticker Options", { exact: true }).click();
    await expect(name).toBeChecked();
    await expect(open).toBeChecked();
    console.log("Actual sticker settings page: independent opt-ins persist after reload.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
