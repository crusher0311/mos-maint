const { chromium, expect } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const { execFileSync } = require("node:child_process");
(async () => {
  const browser = await chromium.launch({ executablePath: execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(), headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.goto("http://127.0.0.1:8098/");
    await expect(page.getByText("Sticker roll may be running low.")).toBeVisible();
    await page.getByRole("button", { name: "New roll / reset estimate" }).click();
    await expect(page.getByRole("button", { name: "Confirm new roll and reset" })).toBeDisabled();
    await page.getByRole("checkbox", { name: /New roll loaded/ }).check();
    await page.getByRole("button", { name: "Confirm new roll and reset" }).click();
    await expect(page.getByText("Sticker roll may be running low.")).toHaveCount(0);
    await expect(page.getByText("0 / 200", { exact: false })).toBeVisible();
    await page.goto("http://127.0.0.1:8098/shops");
    await expect(page.getByText("NOT PRINTED IN 7 DAYS.", { exact: true })).toBeVisible();
    await expect(page.getByText("Fictional Service Shop", { exact: true })).toBeVisible();
    console.log("Offline sticker browser checks passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
