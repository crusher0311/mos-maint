import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { DEFAULT_BRAND, brandSchema } from "../lib/shop-dispatch/model";
import { resolveWorkflowBranding, paletteFromPixels } from "../lib/shop-dispatch/branding";
import { readLogoPalette } from "../lib/shop-dispatch/logo-palette";
import { contrast, manualBrandDraft } from "../components/shop-dispatch/helpers";

const none = { name: null, logo: null, colors: null };
const enterprise = { ...DEFAULT_BRAND, name: "Enterprise", primary: "#112233" };
test("whole location override and field-level shop/enterprise/default precedence", () => {
  const shop = { name: "Location", logo: "embedded", colors: { primary: "#993322", accent: "#227799" } };
  assert.deepEqual(resolveWorkflowBranding(null, none, null).brand, DEFAULT_BRAND);
  assert.deepEqual(resolveWorkflowBranding(null, none, enterprise).brand, enterprise);
  assert.deepEqual(resolveWorkflowBranding(null, shop, enterprise).brand, { name: shop.name, logo: shop.logo, ...shop.colors });
  assert.deepEqual(resolveWorkflowBranding(enterprise, shop, null).brand, enterprise);
  assert.deepEqual(resolveWorkflowBranding(null, { ...none, name: "Saved name" }, enterprise).brand, { ...enterprise, name: "Saved name" });
  assert.equal(resolveWorkflowBranding(null, { ...none, logo: "image" }, enterprise).brand.name, "Enterprise");
  assert.equal(manualBrandDraft({ ...enterprise, logo: "x".repeat(500000) }).logo, null);
  assert.equal(brandSchema.safeParse(manualBrandDraft(enterprise)).success, true);
});
test("transparent and monochrome pixels have no palette; pale colors are darkened", () => {
  assert.equal(paletteFromPixels(new Uint8Array([255, 0, 0, 0, 255, 255, 255, 255])), null);
  assert.equal(paletteFromPixels(new Uint8Array([100, 100, 100, 255])), null);
  assert.deepEqual(paletteFromPixels(new Uint8Array([255, 220, 200, 255])), { primary: "#aa9385", accent: "#aa9385" });
});
test("all foreground choices meet WCAG AA including pale and monochrome palettes", () => {
  for (const color of ["#ffffff", "#000000", "#aa9385", "#285746", "#d66a35", "#777777", "#00ffff"]) {
    const luminance = (hex: string) => {
      const [r, g, b] = hex.slice(1).match(/../g)!.map(v => {
        const n = parseInt(v, 16) / 255;
        return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
      });
      return .2126*r + .7152*g + .0722*b;
    };
    const a = luminance(color), b = luminance(contrast(color));
    assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05) >= 4.5);
  }
});
test("bounded raster decoding, changes/removal, malformed and unsupported input", async () => {
  const image = async (background: string, format: "png" | "jpeg" | "webp" = "png") =>
    `data:image/${format};base64,` + (await sharp({ create: { width: 8, height: 8, channels: 4, background } }).toFormat(format).toBuffer()).toString("base64");
  const red = await image("#ee2222");
  const result = await readLogoPalette(red);
  assert.equal(result.logo, red);
  assert.ok(result.colors);
  assert.strictEqual(await readLogoPalette(red), result);
  assert.notDeepEqual((await readLogoPalette(await image("#2255dd"))).colors, result.colors);
  assert.equal((await readLogoPalette(await image("#ffffff"))).colors, null);
  for (const format of ["jpeg", "webp"] as const) assert.ok((await readLogoPalette(await image("#3355cc", format))).colors);
  for (const input of [null, "", "https://example.com/logo.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,iVBORw0KGgo=", red + "!", "x".repeat(700001)]) {
    assert.deepEqual(await readLogoPalette(input), { logo: null, colors: null });
  }
  const huge = "data:image/png;base64," + (await sharp({ create: { width: 2100, height: 2100, channels: 3, background: "red" } }).png().toBuffer()).toString("base64");
  assert.deepEqual(await readLogoPalette(huge), { logo: null, colors: null });
  assert.equal(resolveWorkflowBranding(null, { name: null, ...await readLogoPalette(null) }, enterprise).brand.logo, enterprise.logo);
});
