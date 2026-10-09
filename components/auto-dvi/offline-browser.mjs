import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer";

// In-memory build and ephemeral loopback server; never starts the root app.
const directory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(directory, "../..");
const result = await build({
  absWorkingDir: workspace,
  entryPoints: ["components/auto-dvi/offline-harness.tsx"], bundle: true, write: false,
  outdir: "components/auto-dvi/offline-build", platform: "browser", jsx: "automatic",
  alias: { "@": workspace }, define: { "process.env.NODE_ENV": '"development"' },
});
const js = result.outputFiles.find(file => file.path.endsWith(".js")).text;
const css = result.outputFiles.find(file => file.path.endsWith(".css")).text;
const server = http.createServer((request, response) => {
  if (request.url === "/bundle.js") { response.setHeader("Content-Type", "application/javascript"); response.end(js); }
  else if (request.url === "/bundle.css") { response.setHeader("Content-Type", "text/css"); response.end(css); }
  else { response.setHeader("Content-Type", "text/html"); response.end('<html><head><link rel="stylesheet" href="/bundle.css"></head><body style="background:#e8eee2;margin:20px"><div id="root"></div><script src="/bundle.js"></script></body></html>'); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let acceptDialogs = true;
  page.on("dialog", dialog => acceptDialogs ? dialog.accept() : dialog.dismiss());
  await page.setRequestInterception(true);
  page.on("request", request => request.url().startsWith(origin) ? request.continue() : request.abort());
  const waitText = async text => {
    try { await page.waitForFunction(text => document.body.innerText.toLowerCase().includes(text.toLowerCase()), {}, text); }
    catch (error) { console.error(`Missing UI text: ${text}\n${await page.evaluate(() => document.body.innerText)}`); throw error; }
  };
  const click = async text => {
    await page.waitForFunction(text => Array.from(document.querySelectorAll("button")).some(b => b.textContent.trim() === text && !b.disabled), {}, text);
    await page.evaluate(text => Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === text && !b.disabled).click(), text);
  };
  const fill = (label, value) => page.evaluate((label, value) => {
    const field = Array.from(document.querySelectorAll("label")).find(node => node.textContent.trim().startsWith(label))?.querySelector("input, textarea, select");
    if (!field) throw new Error(`Missing field ${label}`);
    const prototype = field.tagName === "SELECT" ? HTMLSelectElement.prototype : field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, value);
    field.dispatchEvent(new Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  }, label, value);
  await page.goto(origin);
  await waitText("Ready when the vehicle is.");
  await click("Start inspection");
  await fill("Repair order number", "OFFLINE-101");
  await click("Start this visit");
  await waitText("New visit started");
  assert.equal(await page.evaluate(() => window.__dvi.getRecord().visits[0].results["tire.lf"]?.rating ?? null), null, "history must not autofill");

  // Real editor: controlled measurements, explicit saves and dirty navigation guard.
  await fill("Condition notes", "Draft survives refresh");
  acceptDialogs = false;
  await click("Right front tire");
  assert.equal(await page.$eval("textarea", el => el.value), "Draft survives refresh");
  acceptDialogs = true;
  await page.evaluate(() => { window.__dvi.external(); window.dispatchEvent(new Event("focus")); });
  await waitText("rev 2");
  assert.equal(await page.$eval("textarea", el => el.value), "Draft survives refresh");
  await click("Save item");
  await waitText("Compare before saving again.");
  assert.equal(await page.$eval("textarea", el => el.value), "Draft survives refresh");
  await click("Keep draft against latest revision");
  await click("Save item");
  await waitText("Item saved.");
  assert.equal(await page.evaluate(() => window.__dvi.getRecord().visits[0].results["tire.lf"].notes), "Draft survives refresh");

  await fill("Tread unit", "32nds");
  await fill("Inner tread", "7");
  await fill("Tread unit", "mm");
  assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll("label")).find(l => l.textContent.startsWith("Inner tread")).querySelector("input").value), "", "unit change must clear values");
  await click("Save item");
  await waitText("Item saved.");

  // Validation gate and report gating are actual production UI.
  await click("Complete inspection");
  await waitText("Finish these required entries:");
  await click("03 Customer report");
  await waitText("Report not finalized.");
  await click("Back to technician");
  await fill("Inspection sheet snapshot", "basic");
  await waitText("Visit sheet snapshot selected.");

  // Template CRUD, snapshot immutability.
  await click("Create custom sheet");
  await fill("Sheet name", "Offline safety sheet");
  await page.evaluate(() => document.querySelector('[role="dialog"] input[type="checkbox"]').click());
  await click("Save reusable sheet");
  await waitText("Reusable sheet saved.");
  assert.equal(await page.evaluate(() => window.__dvi.getRecord().visits[0].sheet.id), "basic");
  await click("Edit Offline safety sheet");
  await fill("Sheet name", "Offline revised sheet");
  await click("Save reusable sheet");
  await waitText("Edit Offline revised sheet");
  await click("Delete Offline revised sheet");
  await waitText("Template deleted.");
  assert.equal(await page.evaluate(() => window.__dvi.templates().length), 0);

  // Inspect all catalog items and finalize.
  const names = ["Left front tire", "Right front tire", "Left rear tire", "Right rear tire", "Battery", "Brake visual safety check", "Exterior lighting safety check"];
  for (const name of names) {
    await click(name); await click("Good"); await click("Save item"); await waitText("Item saved.");
    await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Save item")?.disabled);
  }
  await click("Complete inspection");
  await waitText("Inspection completed and locked.");
  assert.equal(await page.evaluate(() => window.__dvi.getRecord().visits[0].status), "complete");
  await click("03 Customer report");
  await waitText("Read-only inspection report.");
  assert.equal(await page.$$("textarea").then(nodes => nodes.length), 0);
  await click("Start next visit");
  await fill("Repair order number", "OFFLINE-102");
  await click("Start this visit");
  await waitText("New visit started");
  assert.deepEqual(await page.evaluate(() => window.__dvi.getRecord().visits[0].results), {});

  // Authorized historical findings disappear when visibility/focus revalidates access.
  await fill("Visit / history", JSON.stringify({ visitId: "historic-fixture", shopId: 17 }));
  await waitText("Historical fixture only");
  assert.equal(await page.$$("textarea").then(nodes => nodes.length), 0);
  await page.evaluate(() => { window.__dvi.revoke(); window.dispatchEvent(new Event("focus")); });
  await waitText("Shared history is not authorized.");
  assert.equal(await page.evaluate(() => document.body.innerText.includes("Historical fixture only")), false);
  await fill("Visit / history", "");
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector("textarea"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "mobile must not overflow");
  const calls = await page.evaluate(() => window.__dvi.calls);
  assert(calls.filter(call => call.action === "save").length >= 9);
  assert(!calls.some(call => /push|voice|generate|photo-assign/.test(call.url)));
  assert.deepEqual(errors, [], "no React runtime errors");
  console.log("PASS: actual component + offline fake API: explicit visits, dirty guard, refresh preservation, 409 comparison, units, validation, template CRUD, immutable completion/report, blank next visit, history revocation, mobile layout, no provider calls.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
