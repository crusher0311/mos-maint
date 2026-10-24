const { chromium, expect } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const { execFileSync } = require("node:child_process");
(async () => {
  const browser = await chromium.launch({ executablePath: execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(), headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.goto("http://127.0.0.1:8099/");
    await expect(page.getByRole("img", { name: "Oil: 5W-30", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Add Oil viscosity", exact: true }).click();
    await expect(page.getByRole("img", { name: "Oil: 5W-30", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.getByRole("img", { name: /^Oil:/ })).toHaveCount(0);
    await page.getByLabel("Oil viscosity (optional)").fill("0w20");
    await page.getByLabel("Oil viscosity (optional)").blur();
    await expect(page.getByRole("img", { name: "Oil: 0W-20", exact: true })).toBeVisible();
    await page.getByText("Position & Size", { exact: true }).click();
    const number = page.locator('input[type="number"]');
    await number.nth(0).fill("10");
    await number.nth(2).fill("120");
    const saved = JSON.parse(await page.getByTestId("layout").textContent());
    expect(saved.elements.find(e => e.type === "oilViscosity")).toMatchObject({ x: 10, width: 120 });
    expect(saved.elements.find(e => e.type === "oilViscosity").content).toBeUndefined();
    await page.getByRole("button", { name: "Remove Oil viscosity", exact: true }).click();
    await expect(page.getByRole("img", { name: /^Oil:/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Open Quick Sticker" }).click();
    const inputs = page.getByLabel("Oil viscosity (optional)");
    await expect(inputs.nth(1)).toHaveValue("");
    await inputs.nth(1).fill("SAE 30");
    // Modal dismissal/reopen must not carry a previous visit's manual value.
    await page.locator(".fixed.inset-0 .absolute.inset-0").click({ position: { x: 5, y: 5 } });
    await page.getByRole("button", { name: "Open Quick Sticker" }).click();
    await expect(inputs.nth(1)).toHaveValue("");
    console.log("PASS production designer, custom grades, clear, movement/resize, removal and Quick Sticker reset");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
