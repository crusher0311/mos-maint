const { chromium } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
(async () => {
  // Never reuse generated population data from a previous checkout.
  const root = path.resolve(__dirname, "../..");
  execFileSync(process.execPath, ["--require", "./tests/helpers/deny-network-egress.cjs",
    "--require", "./scripts/_stubs/server-only-stub.cjs", "--import", "tsx",
    "tests/shop-dispatch-browser/invoice-population-fixtures.ts"], {
    cwd: root, stdio: "inherit", timeout: 30000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH, PROTRACTOR_OFFLINE_ALLOW_LOOPBACK: "true" },
  });
  const browser = await chromium.launch({ executablePath: process.env.DEMO_CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
    });
    await page.goto("http://127.0.0.1:24100/invoice-hours.html");
    await page.getByRole("heading", { name: "Invoice hours", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.invoiceFixture.requests.length), 0, "no automatic query");
    const panel = page.getByRole("tabpanel", { name: "Invoice hours" });
    await panel.getByLabel("Fictional North", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.invoiceFixture.requests.length), 0, "location choices require no report run");
    await panel.getByLabel("Start date").fill("2026-09-01");
    await panel.getByLabel("End date").fill("2026-09-30");
    await panel.getByRole("button", { name: /Run/ }).click();
    await panel.locator("article").filter({ hasText: "Average presented" }).getByText("3.00", { exact: true }).waitFor();
    await panel.locator("article").filter({ hasText: "Average sold" }).getByText("2.00", { exact: true }).waitFor();
    assert.equal(await panel.getByRole("row").count(), 3);
    await panel.getByLabel("Start date").fill("2026-08-01");
    await panel.getByText("2026-09-01 – 2026-09-30", { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.invoiceFixture.requests.length), 1, "draft date does not run");
    await panel.getByRole("button", { name: /Run/ }).click();
    await panel.locator("article").filter({ hasText: "Average presented" }).getByText("Incomplete data", { exact: true }).waitFor();
    await panel.locator("article").filter({ hasText: "Average sold" }).getByText("2.00", { exact: true }).waitFor();
    await panel.getByLabel("Fictional Central", { exact: true }).uncheck();
    await panel.getByRole("button", { name: /Run/ }).click();
    await panel.getByText("Executed results · 1 executed locations", { exact: true }).waitFor();
    assert.equal(await panel.getByRole("row").count(), 2);
    await panel.getByLabel("All authorized locations in this scope").check();
    await panel.getByLabel("Start date").fill("2026-07-01");
    await panel.getByRole("button", { name: /Run/ }).click();
    await panel.getByText("Invoice population uncertain.", { exact: true }).waitFor();
    await panel.getByLabel("Start date").fill("2026-06-01");
    await panel.getByRole("button", { name: /Run/ }).click();
    await panel.locator("article").getByText("No data", { exact: true }).first().waitFor();
    assert.equal(await panel.locator("article").getByText("No data", { exact: true }).count(), 2);
    // Retain completed result while refresh runs and when it fails.
    await page.evaluate(() => { window.invoiceFixture.pending = true; window.invoiceFixture.fail = true; });
    await panel.getByRole("button", { name: /Run/ }).click();
    await panel.getByText("Previous result · refresh in progress", { exact: true }).waitFor();
    await panel.getByRole("alert").waitFor();
    assert.equal(await panel.getByText(/Building in the background/).count(), 0, "failed runs clear the queued notice");
    assert.ok(await panel.getByRole("alert").evaluate(el => el.classList.contains("bg-red-50")), "failures are visibly red");
    assert.equal(await panel.locator("article").getByText("No data", { exact: true }).count(), 2);
    // Scope unmount during a delayed poll must not populate the next scope.
    await page.evaluate(() => { window.invoiceFixture.fail = false; });
    await panel.getByRole("button", { name: /Run/ }).click();
    await page.getByLabel("Reporting scope").selectOption("shop");
    await page.waitForTimeout(2400);
    assert.equal(await panel.locator("article").getByText("Not run yet", { exact: true }).count(), 2);
    await page.getByRole("tab", { name: "Custom reporting", exact: true }).click();
    await page.getByRole("heading", { name: "Report definition" }).waitFor();
    await page.getByRole("tab", { name: "Invoice hours", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile page fits viewport");
    for (const scenario of ["resolved", "conflict", "capped"]) {
      await page.goto(`http://127.0.0.1:24100/invoice-hours.html?population=${scenario}`);
      await panel.getByLabel("Start date").fill("2026-09-01");
      await panel.getByLabel("End date").fill("2026-09-30");
      await panel.getByRole("button", { name: /Run/ }).click();
      await panel.locator("article").filter({ hasText: "Average presented" })
        .getByText(scenario === "resolved" ? "3.00" : "Incomplete data", { exact: true }).waitFor();
      await panel.locator("article").filter({ hasText: "Average sold" })
        .getByText(scenario === "resolved" ? "2.00" : "Incomplete data", { exact: true }).waitFor();
      if (scenario === "capped") {
        await panel.getByText("Invoice coverage capped.", { exact: true }).waitFor();
        await panel.getByText(/100,000 stored-work-order safety limit/).waitFor();
        assert.equal(await panel.locator("article").getByText("No data", { exact: true }).count(), 0);
      }
    }
    assert.deepEqual(errors, []);
    console.log("Invoice dashboard: explicit runs, weighted cards, independent coverage, dates, location, retained results, scope isolation, custom access and mobile: PASS");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
