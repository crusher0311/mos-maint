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
    // Synthetic gradient encoded with libheif; no customer photo or metadata.
    const heic = "AAAAHGZ0eXBoZWl4AAAAAG1pZjFoZWl4bWlhZgAAAUBtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABZAABAAAAAAAAAHoAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAAwGlwcnAAAACiaXBjbwAAAHZodmNDAQQIAAAAAAAAAAAAPPAA/P38/AAADwNgAAEAF0ABDAH//wQIAAADAJm4AAADAAA8ugJAYQABACpCAQEECAAAAwCZuAAAAwAAPKAeIChFKW6kkprm4CGgwIAAAAyAAAADAIRiAAEAB0QBwXKwIkAAAAAUaXNwZQAAAAAAAADwAAAAoAAAABBwaXhpAAAAAAMMDAwAAAAWaXBtYQAAAAAAAAABAAEDgQIDAAAAgm1kYXQAAAB2KAGvE4DlXj7j78aA/pvl9XEpnOS+cUVGVr0c//TKwTYC8b4TsnFNYneRy7mGa5RDZ5/yvq1VJ8HsKsAfbAHXNHo2e6rhvmKqxy4nTz0WRBHYpuR1/c8BaBG4aGyaQNdtcqlW3FI0ey36v9GO1wdlxUxjvAAB8w==";
    for (const type of ["image/heic", ""]) {
      const converted = await page.evaluate(async ({ heic, type }) => {
        const bytes = Uint8Array.from(atob(heic), char => char.charCodeAt(0));
        const file = await photos.prepareROPhoto(new File([bytes], "camera.heic", { type }));
        const image = await createImageBitmap(file);
        return { type: file.type, size: file.size, width: image.width, height: image.height };
      }, { heic: process.env.HEIC_FIXTURE ? require("node:fs").readFileSync(process.env.HEIC_FIXTURE).toString("base64") : heic, type });
      assert.equal(converted.type, "image/jpeg");
      assert.ok(converted.size > 0 && converted.size <= 4 * 1024 * 1024);
      assert.equal(converted.width, 240);
      assert.equal(converted.height, 160);
    }
    console.log("PASS real HEIC conversion, including missing MIME type, produces a readable JPEG");
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
    assert.match(result.errors[0], /could not be converted/);
    assert.match(result.errors[1], /empty/);
    console.log("PASS oversized camera image normalization, small-file preservation, unsupported-format and empty-file errors");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
