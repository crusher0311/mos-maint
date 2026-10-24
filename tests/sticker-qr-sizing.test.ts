import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import sharp from "sharp";
import { inspectQrPixels, qrSizingWarnings } from "../lib/sticker-qr-sizing";
import { createDefaultLayout, STICKER_SIZES } from "../lib/sticker-designer-types";
import { getStickerSizeInches } from "../lib/sticker-pdf";

async function artwork(version: number, padding = 0, margin = 4) {
  const png = await QRCode.toBuffer("https://example.com", { version, scale: 8, margin });
  const { data, info } = await sharp(png).extend({
    left: padding * 2, right: padding, top: padding, bottom: padding, background: "white",
  }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const geometry = inspectQrPixels(new Uint8ClampedArray(data), info.width, info.height);
  assert.ok(geometry);
  return geometry;
}
test("sparse/dense codes: real module density, physical sizes, and PDF inset", async () => {
  const sparse = await artwork(2);
  const dense = await artwork(10);
  for (const size of STICKER_SIZES) {
    assert.deepEqual(getStickerSizeInches(size.value), { width: size.widthInches, height: size.heightInches });
    const layout = createDefaultLayout(size.value);
    const element = { ...layout.elements.find(e => e.type === "qrCode")!, x: 10, y: 10, width: 80, height: 80 };
    assert.deepEqual(qrSizingWarnings(layout, size.value, element, sparse), []);
    assert.match(qrSizingWarnings(layout, size.value, element, dense).join(), /too small/);
    element.width = element.height = 120;
    assert.deepEqual(qrSizingWarnings(layout, size.value, element, dense), []);
  }
});
test("rectangular custom padding reduces usable module size; geometry does not mutate", async () => {
  const layout = createDefaultLayout("2x2");
  const el = { ...layout.elements.find(e => e.type === "qrCode")!, x: 10, y: 10, width: 80, height: 80 };
  const padded = await artwork(2, 100);
  const before = JSON.stringify({ layout, padded, el });
  assert.match(qrSizingWarnings(layout, "2x2", el, padded).join(), /too small/);
  assert.equal(JSON.stringify({ layout, padded, el }), before);
});
test("clipped code/quiet zone, missing border, hidden QR, and unknown image", async () => {
  const layout = createDefaultLayout("2x2");
  const el = { ...layout.elements.find(e => e.type === "qrCode")!, x: -15, y: 10, width: 80, height: 80 };
  assert.match(qrSizingWarnings(layout, "2x2", el, await artwork(2)).join(), /clipped/);
  assert.match(qrSizingWarnings(layout, "2x2", { ...el, x: 10 }, await artwork(2, 0, 0)).join(), /four-module/);
  assert.deepEqual(qrSizingWarnings(layout, "2x2", { ...el, visible: false }, null), []);
  assert.match(qrSizingWarnings(layout, "2x2", el, null).join(), /could not be verified/);
  assert.equal(inspectQrPixels(new Uint8ClampedArray(40 * 40 * 4).fill(255), 40, 40), null);
});
test("contain-fit uses artwork bounds, not unused element area; nonstandard canvas scale is physical", async () => {
  const layout = createDefaultLayout("2x2");
  const qr = await artwork(2);
  const el = { ...layout.elements.find(e => e.type === "qrCode")!, x: -20, y: 10, width: 200, height: 80 };
  assert.deepEqual(qrSizingWarnings(layout, "2x2", el, qr), []);
  const warnings = qrSizingWarnings(layout, "2x2", el, qr);
  assert.deepEqual(qrSizingWarnings({ ...layout, canvasWidth: 400, canvasHeight: 400 },
    "2x2", { ...el, x: el.x * 2, y: el.y * 2, width: el.width * 2, height: el.height * 2 }, qr), warnings);
});
