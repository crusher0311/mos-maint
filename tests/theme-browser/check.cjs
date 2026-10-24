const { chromium } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync("components/theme/theme-runtime.ts", "utf8");
const bootstrap = source.match(/themeBootstrap = `([\s\S]*?)`;/)[1].replace("${THEME_KEY}", "mos-website-appearance");
const base = "http://127.0.0.1:24101";
const out = "generated-artifacts/theme";
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.DEMO_CHROMIUM_PATH || "/usr/bin/chromium", headless: true });
  const context = await browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", route => {
    const url = route.request().url();
    return url.startsWith(base) || url.startsWith("data:") ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", msg => { if (/hydration|did not match|server HTML/i.test(msg.text())) errors.push(msg.text()); });
  const theme = () => page.locator("html").getAttribute("data-theme");
  const select = () => page.getByRole("combobox", { name: "Appearance", exact: true });
  await page.goto(`${base}/?hydrate=1`);
  await select().waitFor();
  assert.equal(await theme(), "dark");
  assert.equal(await select().inputValue(), "system");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await select().selectOption("dark");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(await theme(), "dark");
  await page.reload();
  await select().waitFor();
  assert.equal(await select().inputValue(), "dark");
  assert.equal(await theme(), "dark");
  // Every principal page family uses actual components where possible.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    for (const view of ["landing", "login", "preferences", "admin", "report", "samples"]) {
      await page.goto(`${base}/?view=${view}`);
      await select().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(800);
      for (const mode of ["light", "dark"]) {
        await select().selectOption(mode);
        await page.waitForFunction(mode => document.documentElement.dataset.theme === mode, mode);
        await page.screenshot({ path: path.join(out, `${view}-${width}-${mode}.png`) });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${view} ${width} overflow`);
      }
    }
  }
  await page.getByRole("button", { name: "Open dialog" }).click();
  assert.equal(await page.getByRole("dialog").isVisible(), true);
  await page.screenshot({ path: path.join(out, "dialog-dark.png") });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await select().focus();
  assert.equal(await select().evaluate(e => getComputedStyle(e).outlineStyle), "solid");
  // Same classes retain their original light palette when printing.
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator(".mos-appearance-bar").isVisible(), false);
  assert.equal(await page.getByTestId("card").evaluate(e => getComputedStyle(e).backgroundColor), "rgb(255, 255, 255)");
  await page.emulateMedia({ media: "screen" });
  const blocked = await browser.newContext({ colorScheme: "dark" });
  await blocked.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  });
  const blockedPage = await blocked.newPage();
  blockedPage.on("pageerror", e => errors.push(e.message));
  await blockedPage.goto(base);
  await blockedPage.getByLabel("Appearance", { exact: true }).selectOption("light");
  await blockedPage.waitForFunction(() => document.documentElement.dataset.theme === "light");
  const prepaint = await browser.newContext({ colorScheme: "dark" });
  const first = await prepaint.newPage();
  await first.route("**/main.tsx", route => route.abort());
  await first.goto(base);
  assert.equal(await first.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await first.locator("#root").innerHTML(), "");
  assert.deepEqual(errors, []);
  await browser.close();
  console.log("Theme browser checks passed: device changes, explicit persistence/navigation, blocked storage, page families, desktop/mobile, focus, dialog and print.");
})().catch(e => { console.error(e); process.exit(1); });
