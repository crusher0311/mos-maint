import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewport({ width: 1280, height: 900 });
  // Explicit loopback is the isolated fixture, not the main application.
  await page.goto("http://127.0.0.1:8099/", { waitUntil: "networkidle0" });
  const click = async text => {
    const found = await page.evaluate(text => {
      const button = [...document.querySelectorAll("button")].find(el => el.textContent.trim() === text);
      button?.click(); return !!button;
    }, text);
    assert.ok(found, `Button ${text} exists`);
  };
  await click("Render sample PNG");
  await page.waitForSelector('img[alt="Actual PNG output"]');
  await click("Print details");
  await page.waitForSelector('[role="dialog"]');
  assert.equal(await page.$eval("#keytag-vehicleColor", el => el.value), "Silver");
  assert.equal(await page.$eval("#keytag-licensePlate", el => el.value), "ABC 1234");
  assert.equal(await page.$eval("#keytag-custom_fixture", el => el.value), "");
  await page.type("#keytag-custom_fixture", "North lot, row 12, near the blue entrance gate");
  await mkdir("generated-artifacts/keytags", { recursive: true });
  await page.screenshot({ path: "generated-artifacts/keytags/details.png" });
  await click("Print keytag");
  await page.waitForSelector('[role="dialog"]', { hidden: true });
  await click("Print details");
  await page.waitForSelector('[role="dialog"]');
  assert.equal(await page.$eval("#keytag-custom_fixture", el => el.value), "", "new print resets custom values");
  await page.keyboard.press("Escape");
  await click("Parking");
  await page.waitForSelector("#keytag-field-label");
  assert.equal(await page.$eval("#keytag-field-label", el => el.maxLength), 32);
  await page.click("#keytag-field-label", { clickCount: 3 });
  await page.type("#keytag-field-label", "Location");
  await click("Save");
  await click("Back to all elements");
  await click("Print details");
  await page.waitForSelector('[role="dialog"]');
  assert.equal(await page.$eval('label[for="keytag-custom_fixture"]', el => el.textContent), "Location");
  await page.keyboard.press("Escape");
  await click("Location");
  await page.click('button[title="Hide element"]');
  await click("Save");
  await click("Back to all elements");
  await click("Print details");
  await page.waitForSelector('[role="dialog"]');
  assert.equal(await page.$("#keytag-custom_fixture"), null, "hidden definition does not collect a value");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "generated-artifacts/keytags/designer-and-png.png" });
  assert.deepEqual(errors, []);
  console.log("Browser designer, renamed binding, hide, optional inputs, operation reset and native PNG passed.");
} finally { await browser.close(); }
