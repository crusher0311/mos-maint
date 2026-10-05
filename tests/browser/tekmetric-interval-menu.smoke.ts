/**
 * Task 1301: real Chromium, production Tekmetric button/menu extraction,
 * offline chrome/background/print stubs. No main app or live data.
 *
 * Run: npx tsx tests/browser/tekmetric-interval-menu.smoke.ts
 * For manual screenshot: npx tsx tests/browser/tekmetric-interval-fixture-server.ts
 * then open http://127.0.0.1:5101/ and right-click the MOS print button.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import puppeteer, { type Page } from "puppeteer-core";
import { fixtureHtml } from "./tekmetric-interval-fixture";

const chromium = process.env.CHROMIUM_PATH ||
  execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
let browser: Awaited<ReturnType<typeof puppeteer.launch>>;

async function openPage(width = 960, height = 700) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", request => request.abort()); // No external image, API or production requests.
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(fixtureHtml());
  await page.waitForSelector("#mos-print-button");
  return page;
}

async function position(page: Page, x: number, y: number, closed = false) {
  await page.evaluate(({ x, y, closed }) => {
    const sidebar = document.querySelector("#sidebar")!;
    sidebar.classList.toggle("closed", closed);
    const header = document.querySelector("#header") as HTMLElement;
    header.style.left = `${x}px`;
    header.style.top = `${y}px`;
  }, { x, y, closed });
}

async function open(page: Page) {
  await page.click("#mos-print-button", { button: "right" });
  await page.waitForSelector("#mos-interval-dropdown");
}

async function rendered(page: Page) {
  await page.waitForFunction(() => document.querySelector("#mos-interval-dropdown")?.textContent?.includes("Customize..."));
}

async function rects(page: Page) {
  return page.evaluate(() => {
    const menu = document.querySelector("#mos-interval-dropdown")!.getBoundingClientRect();
    const button = document.querySelector("#mos-print-button")!.getBoundingClientRect();
    const dropdown = document.querySelector("#mos-interval-dropdown")! as HTMLElement;
    return {
      menu: { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom, width: menu.width, height: menu.height },
      button: { left: button.left, right: button.right, top: button.top, bottom: button.bottom },
      viewport: { width: innerWidth, height: innerHeight },
      scrollHeight: dropdown.scrollHeight, clientHeight: dropdown.clientHeight,
      textOverflow: [...dropdown.children].some(item => item.scrollWidth > item.clientWidth + 2),
    };
  });
}

function bounded(geometry: Awaited<ReturnType<typeof rects>>) {
  const { menu: m, viewport: v } = geometry;
  assert.ok(m.left >= -1 && m.top >= -1 && m.right <= v.width + 1 && m.bottom <= v.height + 1,
    `menu overflowed viewport: ${JSON.stringify(geometry)}`);
  assert.ok(m.width <= 321 && m.width >= Math.min(179, v.width - 16), `menu width: ${m.width}`);
  assert.equal(geometry.textOverflow, false, "label must wrap within menu");
}

async function activeListeners(page: Page) {
  return page.evaluate(() => {
    const tracking = (window as any).trackedListeners;
    return tracking.added.filter((entry: any) =>
      !tracking.removed.some((removed: any) => removed.callback === entry.callback &&
        removed.target === entry.target && removed.type === entry.type)).length;
  });
}

async function waitClosed(page: Page) {
  await page.waitForFunction(() => !document.querySelector("#mos-interval-dropdown"));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await activeListeners(page), 0, "dismissed menu must release document/window listeners");
}

const configured = {
  config: {
    useKilometers: true,
    intervals: {
      conventional: { mileage: 3000, months: 3, label: "Very long custom shop interval label ".repeat(8) },
      synthetic: { mileage: 5000, months: 6, label: "UnbreakableIntervalName".repeat(15) },
      euro: { mileage: 10000, months: 12, label: "Euro" },
      diesel: { mileage: 7500, months: 6, hidden: true },
    },
  },
};

async function main() {
browser = await puppeteer.launch({
  executablePath: chromium,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"],
});
try {
  for (const closed of [false, true]) {
    for (const [name, x, y] of [["center", 380, 100], ["right-bottom", 840, 640]] as const) {
      const page = await openPage();
      try {
        await position(page, x, y, closed);
        await page.evaluate(config => { (window as any).configResult = config; }, configured);
        await open(page);
        bounded(await rects(page)); // loading state must also be bounded
        await rendered(page);
        const geometry = await rects(page);
        bounded(geometry);
        if (name === "right-bottom") assert.ok(geometry.menu.bottom <= geometry.button.top + 1, "should flip above");
        const text = await page.$eval("#mos-interval-dropdown", el => el.textContent || "");
        assert.match(text, /Very long custom shop interval label/);
        assert.match(text, /3,000 km/);
        assert.doesNotMatch(text, /Diesel/);
        // Preset selection should close and pass the selected interval, units and vehicle to print.
        await page.evaluate(() => (document.querySelector("#mos-interval-dropdown")!.children[0] as HTMLElement).click());
        await waitClosed(page);
        await page.waitForFunction(() => (window as any).calls.some((call: any) => call.action === "PRINT_STUB"));
        const calls = await page.evaluate(() => (window as any).calls);
        assert.deepEqual(calls.find((call: any) => call.overrideInterval)?.overrideInterval, { miles: 3000, months: 3 });
        assert.equal(calls.find((call: any) => call.overrideInterval)?.context.useKilometers, true);
      } finally { await page.close(); }
    }
  }

  // A small CSS viewport emulates browser zoom; labels must wrap, vertical
  // overflow must scroll, and the menu must remain usable in both layouts.
  for (const [width, height] of [[320, 290], [352, 312]] as const) {
    const page = await openPage(width, height);
    try {
      await position(page, 65, 195, true);
      await page.evaluate(config => { (window as any).configResult = config; }, configured);
      await open(page);
      await rendered(page);
      const geometry = await rects(page);
      bounded(geometry);
      assert.ok(geometry.scrollHeight > geometry.clientHeight, "tall wrapped menu should scroll");
      assert.ok(geometry.menu.top < geometry.button.top, "menu should flip upward near bottom");
    } finally { await page.close(); }
  }

  const page = await openPage();
  try {
    await page.evaluate(() => { (window as any).configMode = "delayed"; });
    await position(page, 830, 615);
    await open(page);
    bounded(await rects(page));
    await position(page, 300, 80);
    await page.waitForFunction(() => {
      const menu = document.querySelector("#mos-interval-dropdown");
      const button = document.querySelector("#mos-print-button");
      if (!menu || !button) return false;
      return Math.abs(menu.getBoundingClientRect().left - button.getBoundingClientRect().left) < 20;
    });
    await page.setViewport({ width: 650, height: 460, deviceScaleFactor: 1 });
    bounded(await rects(page));
    await page.evaluate(() => (window as any).resolveConfig(null)); // delayed/missing config falls back
    await rendered(page);
    assert.match(await page.$eval("#mos-interval-dropdown", el => el.textContent || ""), /Conventional: 3,000 mi/);
    await page.evaluate(() => window.scrollTo(0, 160));
    await waitClosed(page); // external page scrolling dismisses
    await page.evaluate(() => window.scrollTo(0, 0));
    await open(page);
    await page.evaluate(() => (window as any).resolveConfig(null));
    await rendered(page);
    await page.evaluate(() => {
      document.querySelector("#mos-interval-dropdown")!.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
    assert.ok(await page.$("#mos-interval-dropdown"), "menu's own scrolling must not dismiss");
    await page.click("#outside");
    await waitClosed(page);

    // Toggle repeatedly while config is unresolved. Stale responses may never
    // recreate a menu, and each dismissal must remove all global listeners.
    await page.evaluate(() => window.scrollTo(0, 0));
    await position(page, 300, 80);
    for (let i = 0; i < 4; i++) {
      await open(page);
      await page.click("#mos-print-button", { button: "right" });
      await waitClosed(page);
    }
    await page.evaluate(config => (window as any).resolveConfig(config), configured);
    assert.equal(await page.$("#mos-interval-dropdown"), null);
    await open(page);
    await page.evaluate(() => (window as any).resolveConfig(null));
    await rendered(page);
    await page.evaluate(() => [...document.querySelector("#mos-interval-dropdown")!.children]
      .find(el => el.textContent === "Customize...")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await waitClosed(page);
    assert.equal(await page.evaluate(() => (window as any).calls.filter((call: any) => call.action === "CUSTOMIZE").length), 1);

    await open(page);
    await page.evaluate(() => (window as any).resolveConfig(null));
    await rendered(page);
    await page.evaluate(() => document.querySelector("#header")!.remove());
    await waitClosed(page); // removed anchor cannot leave an orphaned menu

    // A nested Tekmetric scroller also dismisses; Escape and offscreen
    // anchors leave no click/scroll listeners behind.
    await page.goto("about:blank");
    await page.setContent(fixtureHtml());
    await open(page);
    await rendered(page);
    await page.evaluate(() => {
      const scroller = document.querySelector("#workspace")!;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await waitClosed(page);
    await open(page);
    await page.keyboard.press("Escape");
    await waitClosed(page);
    await open(page);
    await page.evaluate(() => { (document.querySelector("#header") as HTMLElement).style.left = "-500px"; });
    await waitClosed(page);

  } finally { await page.close(); }
  // Ordinary left click still requests an immediate print with no override.
  const printPage = await openPage();
  try {
    await printPage.click("#mos-print-button");
    await printPage.waitForFunction(() => (window as any).calls.some((call: any) => call.action === "PRINT_STUB"));
    const print = await printPage.evaluate(() => (window as any).calls.find((call: any) => call.action === "PRINT_STICKER_IMMEDIATE"));
    assert.equal(print.overrideInterval, undefined);
    assert.equal(print.context.roId, "fixture-ro");
  } finally { await printPage.close(); }
  console.log("✓ Task 1301 Tekmetric interval menu Chromium regressions passed");
} finally {
  await browser.close();
}
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});