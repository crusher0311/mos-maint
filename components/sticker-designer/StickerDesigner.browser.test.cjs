// Uses the existing isolated Vite fixture configuration, never the main app.
// node components/sticker-designer/StickerDesigner.browser.test.cjs
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");

(async () => {
  const root = path.resolve(__dirname, "../..");
  const { createServer } = await import("../../artifacts/detect-dog-workflow/node_modules/vite/dist/node/index.js");
  const css = await postcss([tailwind()]).process(
    '@import "tailwindcss" source(none); @source "./StickerDesigner.tsx"; @source "./StickerElementPanel.tsx"; @source "./StickerToolbarPanel.tsx"; @source "./StickerDesignerCanvas.tsx"; @source "./StickerDesigner.fixture.tsx";',
    { from: path.join(__dirname, "fixture-input.css") },
  );
  const server = await createServer({
    configFile: path.join(root, "tests/shop-dispatch-browser/vite.config.mjs"),
    server: { port: 24119 },
    plugins: [{
      name: "isolated-sticker-controls-fixture",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url === "/sticker-designer-controls.css") {
            res.setHeader("Content-Type", "text/css");
            res.end(css.css);
          } else if (req.url === "/sticker-designer-controls.html") {
            const html = fs.readFileSync(path.join(__dirname, "StickerDesigner.fixture.html"), "utf8").replace("__WORKSPACE__", root);
            res.setHeader("Content-Type", "text/html");
            res.end(await vite.transformIndexHtml(req.url, html));
          } else next();
        });
      },
    }],
  });
  await server.listen();
  const executablePath = process.env.DEMO_CHROMIUM_PATH || process.env.CHROMIUM_PATH ||
    require("node:child_process").execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
  const browser = await chromium.launch({ executablePath, headless: true });
  let passed = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 1100 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", (route) => route.abort("blockedbyclient"));
    await page.goto("http://127.0.0.1:24119/sticker-designer-controls.html");
    const button = (name) => page.getByRole("button", { name, exact: true });
    const state = () => page.getByTestId("layout-state").textContent().then(JSON.parse);
    const panel = page.locator(".w-72");
    const select = (label) => panel.getByText(label, { exact: true }).click();
    const custom = async () => (await state()).elements.find((element) => element.type === "text");
    const nativeColor = async (label, value) => {
      await page.getByLabel(label, { exact: true }).evaluate((element, color) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, color);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    };

    await select("Service Label");
    await button("Underline").click();
    await page.getByLabel("Text color value", { exact: true }).fill("red");
    assert.equal((await state()).elements.find(e => e.type === "serviceLabel").color, "red");
    await page.getByLabel("Text color value", { exact: true }).fill("not-a-color");
    assert.equal(await page.getByRole("alert").count(), 1);
    assert.equal((await state()).elements.find(e => e.type === "serviceLabel").color, "red");
    await page.getByLabel("Text color value", { exact: true }).fill("#000000");
    assert.equal((await state()).elements.find((e) => e.type === "serviceLabel").underline, true);
    assert.equal(await page.getByLabel("Label Text", { exact: true }).count(), 0);
    assert.equal(await button("Use shop default").count(), 0);
    const beforeLabelEdits = await state();
    for (const label of ["Next Oil Service", "Next Maintenance", "", "   "]) {
      await page.getByLabel("Service Label", { exact: true }).fill(label);
      assert.equal(await page.getByRole("img", { name: label.trim() ? label : "Next Service Due", exact: true }).count(), 1);
      assert.deepEqual(await state(), beforeLabelEdits, "wording edits do not mutate layout");
    }
    await button("Add custom text").click();
    await page.getByLabel("Custom Text", { exact: true }).fill("Ask about tire rotation");
    const id = (await custom()).id;
    await button("Bold").click();
    await button("Italic").click();
    await button("Underline").click();
    await page.getByLabel("Background", { exact: true }).check();
    await nativeColor("Background color", "#fff1b8");
    await page.getByLabel("Border", { exact: true }).check();
    await nativeColor("Border color", "#334155");
    await page.getByLabel("Border thickness", { exact: true }).fill("2.5");
    assert.equal((await custom()).borderWidth, 2.5);
    assert.equal((await custom()).borderColor, "#334155");
    assert.equal((await custom()).backgroundColor, "#fff1b8");
    assert.equal((await custom()).underline, true);
    assert.equal((await custom()).fontWeight, "bold");
    assert.equal((await custom()).fontStyle, "italic");
    fs.mkdirSync(path.join(root, "generated-artifacts"), { recursive: true });
    await page.screenshot({ path: path.join(root, "generated-artifacts/sticker-designer-controls.png"), fullPage: true });
    await button("Clear background").click();
    await button("Clear border").click();
    assert.equal((await custom()).backgroundColor, undefined);
    assert.equal((await custom()).borderWidth, undefined);
    page.once("dialog", (dialog) => dialog.dismiss());
    await button("Remove custom text").click();
    assert.equal((await custom()).id, id);
    page.once("dialog", (dialog) => dialog.accept());
    await button("Remove custom text").click();
    assert.equal(await custom(), undefined);
    await page.getByTitle("Undo (Ctrl+Z)").click();
    assert.equal((await custom()).id, id);
    await page.getByLabel("Custom Text", { exact: true }).fill("Restored selection");
    assert.equal((await custom()).content, "Restored selection");
    for (const type of ["Logo", "QR Code"]) {
      await select(type);
      assert.equal(await button("Underline").count(), 0);
      assert.equal(await page.getByLabel("Background", { exact: true }).count(), 0);
      assert.equal(await page.getByLabel("Border", { exact: true }).count(), 0);
      assert.equal(await button("Remove custom text").count(), 0);
    }
    await select("Logo");
    await button("cover").click();
    assert.equal((await state()).elements.find((e) => e.type === "logo").imageFit, "cover");
    await select("QR Code");
    await page.getByRole("button", { name: "Hide QR Code", exact: true }).click();
    assert.equal((await state()).elements.find((e) => e.type === "qrCode").visible, false);
    for (let i = 1; i < 12; i++) await button("Add custom text").click();
    assert.equal(await button("Add custom text").isDisabled(), true);
    assert.equal((await state()).elements.filter((e) => e.type === "text").length, 12);
    assert.deepEqual(errors, []);
    passed = true;
    console.log("Sticker designer browser lifecycle checks passed. Fixture: http://127.0.0.1:24119/sticker-designer-controls.html");
  } finally {
    await browser.close();
    if (!passed || !process.argv.includes("--keep-open")) await server.close();
    else console.log("Fixture left open for screenshot verification.");
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
