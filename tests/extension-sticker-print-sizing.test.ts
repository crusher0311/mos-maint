// Offline: node --import tsx tests/extension-sticker-print-sizing.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { PDFDocument } from "pdf-lib";
import { createCanvas, loadImage } from "canvas";
import { STICKER_SIZE_INCHES } from "../lib/sticker-print-dimensions";
import { buildStickerPrintHtml } from "../lib/print-sticker";

const output = "generated-artifacts/sticker-sizing";
fs.mkdirSync(output, { recursive: true });
const coreSource = fs.readFileSync("mos-tools-extension/sticker-print-core.js", "utf8");
const paths = ["tekmetric", "shopware", "autoflow"].map(p => `mos-tools-extension/adapters/${p}-content.js`);
paths.push("mos-tools-extension/sidepanel.js");
function functionSource(source: string, popup: boolean) {
  const start = source.indexOf(`function ${popup ? "printStickerViaWindow" : "printStickerFromContentScript"}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
function capture(source: string, popup: boolean, sticker: any, options: any = {}) {
  let html = "", printed = 0, failed = 0, removed = 0;
  const timers: Function[] = [];
  const img: any = { complete: options.complete ?? true, naturalWidth: options.broken ? 0 : 591, naturalHeight: options.broken ? 0 : 591 };
  const doc = { open() {}, close() {}, write(s: string) { html = s; }, getElementById() { return img; } };
  const win = { document: doc, focus() {}, print() { printed++; }, close() { removed++; } };
  const frame = { style: {}, contentDocument: doc, contentWindow: win, remove() { removed++; } };
  const context: any = {
    console, document: { createElement: () => frame, body: { appendChild() {} } },
    window: { open: () => options.blocked ? null : win },
    detectContext: () => options.context || { shopId: "1", roId: "2" },
    showToast: () => failed++, showNotification: () => failed++,
    setTimeout: (fn: Function) => { timers.push(fn); },
  };
  vm.createContext(context);
  vm.runInContext(coreSource, context);
  vm.runInContext(functionSource(source, popup), context);
  context[popup ? "printStickerViaWindow" : "printStickerFromContentScript"](sticker);
  const flush = () => { while (timers.length) timers.shift()!(); };
  return { html, img, flush, stats: () => ({ printed, failed, removed }), context };
}
async function main() {
const browser = await puppeteer.launch({
  executablePath: execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
  headless: true, args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", req => void (req.url().startsWith("data:") || req.url() === "about:blank" ? req.continue() : req.abort()));
  const manifest = JSON.parse(fs.readFileSync("mos-tools-extension/manifest.json", "utf8"));
  for (const path of paths.slice(0, 3)) {
    const relative = path.replace("mos-tools-extension/", "");
    const entry = manifest.content_scripts.find((s: any) => s.js.includes(relative));
    assert.ok(entry.js.indexOf("sticker-print-core.js") < entry.js.indexOf(relative));
  }
  const panelHtml = fs.readFileSync("mos-tools-extension/sidepanel.html", "utf8");
  assert.ok(panelHtml.indexOf('src="sticker-print-core.js"') < panelHtml.indexOf('src="sidepanel.js"'));
  assert.match(fs.readFileSync("mos-tools-extension/background.js", "utf8"), /files: \['sticker-print-core.js', 'adapters\/shopware-content.js'\]/);
  const core: any = {};
  vm.runInNewContext(coreSource, core);
  assert.deepEqual(JSON.parse(JSON.stringify(core.MosStickerPrintCore.sizes)),
    Object.fromEntries(Object.entries(STICKER_SIZE_INCHES).map(([key, d]) => [key, [d.width, d.height]])));
  assert.throws(() => core.MosStickerPrintCore.buildHtml({ size: "invalid" }), /Unsupported/);
  const api = fs.readFileSync("app/api/extension/sticker/route-handler.ts", "utf8");
  assert.match(api, /getStickerSizeInches\(size\)/);
  assert.match(api, /widthInches: `\$\{sizeInches.width\}in`/);
  for (const [size, { width, height }] of Object.entries(STICKER_SIZE_INCHES)) {
    // Use the unchanged API raster dimensions, including their rounding.
    const [rw, rh] = ({ "1.5x2.25": [443, 665], "2x2": [591, 591], "2x2.5": [591, 739], "2x3": [591, 887], "2x3.5": [591, 1035] } as any)[size];
    const canvas = createCanvas(rw, rh), ctx = canvas.getContext("2d");
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, rw, rh);
    // All four edge markers must survive PDF rendering, not just the DOM box.
    ctx.fillStyle = "black"; ctx.fillRect(0, 0, rw, 8); ctx.fillRect(0, rh - 8, rw, 8);
    ctx.fillRect(0, 0, 8, rh); ctx.fillRect(rw - 8, 0, 8, rh);
    ctx.fillRect(rw / 2 - 50, rh / 2 - 50, 100, 100);
    ctx.fillText("Offline sticker geometry", 25, 50);
    const sticker = { size, dataUrl: canvas.toDataURL(), widthInches: "1.97in", heightInches: size === "2x3" ? "2.96in" : `${height}in` };
    const documents: [string, string][] = [];
    for (const path of paths) {
      const popup = path.includes("sidepanel");
      const source = fs.readFileSync(path, "utf8");
      const captured = capture(source, popup, sticker);
      captured.img.onload(); captured.img.onload(); captured.flush();
      assert.equal(captured.stats().printed, 1);
      documents.push([popup ? "popup" : path.split("/").at(-1)!, captured.html]);
      const slow = capture(source, popup, sticker, { complete: false });
      slow.flush(); assert.equal(slow.stats().printed, 0);
      slow.img.onload(); slow.img.onload(); slow.flush(); assert.equal(slow.stats().printed, 1);
      const broken = capture(source, popup, sticker, { broken: true });
      broken.flush(); assert.equal(broken.stats().printed, 0); assert.equal(broken.stats().failed, 1);
    }
    documents.push(["website", buildStickerPrintHtml(sticker.dataUrl, size)]);
    for (const [name, html] of documents) {
      await page.setContent(html);
      await page.waitForFunction(() => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0));
      await page.emulateMediaType("print");
      const bounds = await page.$eval("img", img => {
        const r = img.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, fit: getComputedStyle(img).objectFit };
      });
      assert.deepEqual(bounds, { x: 0, y: 0, width: width * 96, height: height * 96, fit: "contain" });
      assert.equal(await page.$eval("img", img => img.getAttribute("src")), sticker.dataUrl);
      const file = `${output}/${size}-${name}`;
      fs.writeFileSync(`${file}.html`, html);
      const pdfBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true, path: `${file}.pdf` });
      const pdf = await PDFDocument.load(pdfBytes);
      assert.equal(pdf.getPageCount(), 1, file);
      assert.ok(Math.abs(pdf.getPage(0).getWidth() - width * 72) < 0.1);
      assert.ok(Math.abs(pdf.getPage(0).getHeight() - height * 72) < 0.1);
      execFileSync("pdftoppm", ["-scale-to", "600", "-singlefile", "-png", `${file}.pdf`, file]);
      const image = await loadImage(`${file}.png`);
      const raster = createCanvas(image.width, image.height), rc = raster.getContext("2d");
      rc.drawImage(image, 0, 0);
      for (const [x, y] of [[2, image.height / 2], [image.width - 3, image.height / 2], [image.width / 2, 2], [image.width / 2, image.height - 3]]) {
        assert.ok(rc.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[0] < 100, `${file}: missing edge ${x},${y}`);
      }
      const cx = Math.floor(image.width / 2), cy = Math.floor(image.height / 2);
      const span = (dx: number, dy: number) => {
        let n = 0;
        while (rc.getImageData(cx + dx * n, cy + dy * n, 1, 1).data[0] < 100 && n < 200) n++;
        return n;
      };
      assert.ok(Math.abs((span(1, 0) + span(-1, 0)) - (span(0, 1) + span(0, -1))) <= 2, `${file}: distorted square`);
    }
    console.log(`PASS ${size}: three adapters, popup, website; one page, nominal inches, four PDF edges`);
  }
  const source = fs.readFileSync(paths[0], "utf8");
  const bound = { size: "2x2", dataUrl: "", mosPrintContext: { shopId: "1", roId: "2" } };
  const mismatch = capture(source, false, bound, { context: { shopId: "3" } });
  assert.equal(mismatch.html, ""); assert.equal(mismatch.stats().printed, 0);
  const changed = capture(source, false, bound);
  changed.context.detectContext = () => ({ shopId: "4" });
  changed.flush(); assert.equal(changed.stats().printed, 0); assert.equal(changed.stats().failed, 1);
  const blocked = capture(fs.readFileSync(paths[3], "utf8"), true, bound, { blocked: true });
  assert.equal(blocked.stats().failed, 1); assert.equal(blocked.html, "");
} finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
