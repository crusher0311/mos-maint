const assert = require("node:assert/strict");
const { build } = require("esbuild");
const { chromium } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
(async () => {
  const bundle = await build({ entryPoints: ["components/ro-photo-input.ts"], bundle: true, write: false, format: "iife", globalName: "photos", platform: "browser" });
  const browser = await chromium.launch({ executablePath: require("node:child_process").execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(), headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 200; canvas.height = 200;
      canvas.getContext("2d").fillRect(0, 0, 200, 200);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      const small = new File([blob], "small.png", { type: "image/png" });
      const large = new File([blob, new Uint8Array(5 * 1024 * 1024)], "phone.png", { type: "image/png" });
      const prepared = await photos.prepareROPhoto(large);
      const errors = [];
      for (const file of [new File(["heic"], "phone.heic", { type: "image/heic" }), new File([], "empty.jpg", { type: "image/jpeg" })]) {
        try { await photos.prepareROPhoto(file); } catch (error) { errors.push(error.message); }
      }
      return { same: await photos.prepareROPhoto(small) === small, size: prepared.size, type: prepared.type, errors };
    });
    assert.equal(result.same, true);
    assert.equal(result.type, "image/jpeg");
    assert.ok(result.size > 0 && result.size < 4 * 1024 * 1024);
    assert.match(result.errors[0], /Most Compatible/);
    assert.match(result.errors[1], /empty/);
    console.log("PASS oversized camera image normalization, small-file preservation, unsupported-format and empty-file errors");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
