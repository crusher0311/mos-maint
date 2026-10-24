const { chromium } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.DEMO_CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto("http://127.0.0.1:24100/sticker-qr.html");
    await page.getByRole("radio", { name: /Uploaded QR code/ }).check();
    await page.getByText(/No generated code will be substituted/).waitFor();
    await page.locator('input[type="file"]').setInputFiles("generated-artifacts/sticker-qr.png");
    await page.getByRole("button", { name: "Replace image", exact: true }).waitFor();
    await page.getByAltText("Uploaded QR preview").waitFor();
    await page.getByLabel("QR background", { exact: true }).selectOption("match");
    await page.getByLabel("Sticker background").fill("#111111");
    await page.getByText(/The QR background stays white/).waitFor();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("button", { name: "Remove image", exact: true }).click();
    await page.getByText(/No generated code will be substituted/).waitFor();
    assert.ok(await page.getByRole("radio", { name: /Uploaded QR code/ }).isChecked());
    await page.getByRole("radio", { name: /MOS-generated code/ }).check();
    await page.getByAltText("MOS-generated QR preview").waitFor();
    await page.getByLabel("Show QR code").uncheck();
    await page.getByText(/QR codes are excluded/).waitFor();
    assert.equal(await page.locator("img").count(), 0);
    assert.deepEqual(errors, []);
    console.log("QR controls browser checks passed.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
