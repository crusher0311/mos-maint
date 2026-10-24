// Run with the "Shop Workflow offline checks" fixture workflow on port 24100.
import test from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { execFileSync } from "node:child_process";

test("designer recalculates warnings for artwork changes, edits, undo, and visibility", async () => {
  let executablePath: string;
  try { executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(); }
  catch { executablePath = await chromium.executablePath(); }
  const browser = await puppeteer.launch({
    executablePath,
    headless: true, args: chromium.args,
  });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", req => {
      if (req.url().startsWith("http://127.0.0.1:24100/") || req.url().startsWith("data:")) void req.continue();
      else void req.abort();
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto("http://127.0.0.1:24100/sticker-sizing.html");
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("too small"));
    const clickText = async (text: string) => page.evaluate(text => {
      const button = [...document.querySelectorAll("button")].find(b => b.textContent === text);
      if (!button) throw new Error(`Missing button ${text}`);
      button.click();
    }, text);
    await clickText("Toggle density");
    await page.waitForFunction(() => !document.querySelector('[role="status"]'));
    await clickText("Toggle density");
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("too small"));
    await clickText("Toggle QR visibility");
    await page.waitForFunction(() => !document.querySelector('[role="status"]'));
    await clickText("Toggle QR visibility");
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("too small"));
    await page.evaluate(() => {
      [...document.querySelectorAll("span")].find(el => el.textContent === "QR Code")?.click();
    });
    await page.waitForFunction(() => [...document.querySelectorAll("h3")].some(el => el.textContent === "Position & Size"));
    await page.evaluate(() => {
      [...document.querySelectorAll("h3")].find(el => el.textContent === "Position & Size")?.click();
    });
    await page.waitForFunction(() => [...document.querySelectorAll("label")].some(el => el.textContent === "Width"));
    const setField = async (label: string, value: string) => {
      await page.evaluate(({ label, value }) => {
        const field = [...document.querySelectorAll("label")].find(el => el.textContent === label)?.parentElement?.querySelector("input");
        if (!field) throw new Error(`Missing field ${label}`);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }, { label, value });
    };
    await setField("Width", "120");
    await setField("Height", "120");
    await page.waitForFunction(() => !document.querySelector('[role="status"]'));
    await setField("X", "-30");
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("clipped"));
    await page.click('button[title="Undo (Ctrl+Z)"]');
    await page.waitForFunction(() => !document.querySelector('[role="status"]'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
