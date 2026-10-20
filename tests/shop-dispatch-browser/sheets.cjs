// Run against the already-running offline Vite fixture; never starts services.
const { chromium } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.DEMO_CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], requests = [], posts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      requests.push(request.url());
      if (request.method() === "POST") posts.push(request.postData());
    });
    page.on("dialog", dialog => dialog.accept());
    const visit = async query => {
      await page.goto(`http://127.0.0.1:24100/?sheets${query}`);
      if (query.includes("sheetsDenied")) await page.getByText("Inspection sheets are not available", { exact: true }).waitFor();
      else await page.getByTestId("sheet-manager").waitFor();
    };
    await visit("");
    await page.getByRole("button", { name: "Edit latest version", exact: true }).click();
    await page.getByLabel("Sheet name", { exact: true }).fill("Arrival & roadworthiness revised");
    await page.getByText("Publishing automatically advances the default", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Publish new version", exact: true }).click();
    await page.getByText("arrival-check@3 · 5 items", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Preview immutable version").inputValue(), "arrival-check@3");
    await page.getByLabel("Preview immutable version").selectOption("arrival-check@1");
    await page.getByText("arrival-check@1 · 3 items", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit latest version", exact: true }).click();
    assert.equal(await page.getByLabel("Sheet name", { exact: true }).inputValue(), "Arrival & roadworthiness revised");
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await page.getByRole("button", { name: "Create sheet", exact: true }).waitFor();

    await visit("&sheetsUncertain");
    await page.getByRole("button", { name: "Edit latest version", exact: true }).click();
    await page.getByLabel("Sheet name", { exact: true }).fill("Retained receipt draft");
    await page.getByRole("button", { name: "Publish new version", exact: true }).click();
    await page.getByRole("button", { name: "Retry exact save", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Discard draft", exact: true }).isDisabled(), true);
    const firstPayload = posts.at(-1);
    await page.getByRole("button", { name: "Retry exact save", exact: true }).click();
    await page.getByText("arrival-check@3 · 5 items", { exact: true }).waitFor();
    assert.equal(posts.at(-1), firstPayload);

    await visit("&sheetsConflict");
    await page.getByRole("button", { name: "Edit latest version", exact: true }).click();
    await page.getByLabel("Sheet name", { exact: true }).fill("Retained conflict draft");
    await page.getByRole("button", { name: "Publish new version", exact: true }).click();
    await page.getByRole("button", { name: "Discard draft and reload latest", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Sheet name", { exact: true }).inputValue(), "Retained conflict draft");
    assert.equal(await page.getByRole("button", { name: "Publish new version", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Discard draft and reload latest", exact: true }).click();
    await page.getByText("Catalog revision 24", { exact: true }).waitFor();

    await visit("&sheetsReadonly&sheetsEnterprise&sheetsOff");
    await page.getByText(/Read-only · Cedar Automotive Group/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Create sheet", exact: true }).count(), 0);
    await page.getByText(/Publishing or managing sheets does not enable inspection admissions/).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: "/tmp/dvi-sheets-mobile-offline.png", fullPage: true });

    await visit("&sheetsLoadError");
    await page.getByRole("button", { name: "Retry loading sheets", exact: true }).click();
    await page.getByRole("button", { name: "Create sheet", exact: true }).waitFor();
    await visit("&sheetsDenied");
    await page.getByText("Inspection sheets are not available", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Create sheet", exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    assert.equal(requests.some(url => !url.startsWith("http://127.0.0.1:24100") && !url.startsWith("data:")), false);
    console.log("Offline Sheets browser: immutable preview, default advancement, latest-version edits, exact retry, explicit conflict discard, enterprise read-only, rollout separation, mobile width, retryable load and denied access passed. No live requests.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
