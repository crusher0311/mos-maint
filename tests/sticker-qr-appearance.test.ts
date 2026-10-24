import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import sharp from "sharp";
import jsQR from "jsqr";
import { normalizeCustomQr, styleStickerQr, customStickerQr } from "../lib/sticker-qr-image";
import { resolveQrBackground, validQrPreferences } from "../lib/sticker-qr-appearance";
import { renderStickerDesigner, renderStickerStandard } from "../lib/canvas-renderer";
import { pngBufferToSizedPdfBuffer } from "../lib/sticker-pdf";
import { snapshotEnterpriseSettings, buildEnterpriseSettingsReplacement } from "../lib/enterprise-settings-catalog";

const target = "https://offline.example.test/unchanged";
const bytes = () => QRCode.toBuffer(target, { width: 300, margin: 4 });
async function decoded(uri: string | Buffer) {
  const buffer = typeof uri === "string" ? Buffer.from(uri.split(",")[1], "base64") : uri;
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
}
test("conservative contrast policy and backwards-compatible validation", () => {
  for (const color of ["#fffaf0", "#eeeeee", "#e0e0e0"]) assert.equal(resolveQrBackground("match", color).color, color);
  for (const color of ["#000000", "#aaaaaa", "#ff00ff", "red", "url(x)"]) {
    assert.equal(resolveQrBackground("match", color).color, "#ffffff");
    assert.ok(resolveQrBackground("match", color).warning);
  }
  assert.equal(resolveQrBackground(undefined, "#eeeeee").color, "#ffffff");
  assert.ok(validQrPreferences({}));
  assert.ok(!validQrPreferences({ qrSource: "remote" as any }));
});
test("normalizes raster images, rejects invalid/oversized/non-QR files without fetching destinations", async () => {
  assert.equal(await decoded(await normalizeCustomQr(await bytes())), target);
  await assert.rejects(normalizeCustomQr(Buffer.alloc(512001)), /500KB/);
  await assert.rejects(normalizeCustomQr(Buffer.from("<svg/>")), /readable/);
  const blank = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(normalizeCustomQr(blank), /No readable QR/);
  const large = await sharp({ create: { width: 2049, height: 10, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(normalizeCustomQr(large), /2048/);
});
test("generated appearance preserves payload and quiet zones; custom opaque pixels unchanged", async () => {
  const original = await normalizeCustomQr(await bytes());
  for (const color of ["#fffaf0", "#eeeeee", "#000000"]) {
    const styled = await styleStickerQr(original, { qrBackgroundMode: "match" }, color);
    assert.equal(await decoded(styled), target);
    const { data } = await sharp(Buffer.from(styled.split(",")[1], "base64")).raw().toBuffer({ resolveWithObject: true });
    const expected = resolveQrBackground("match", color).color;
    assert.deepEqual([...data.slice(0, 3)], [1, 3, 5].map(i => parseInt(expected.slice(i, i + 2), 16)));
  }
  const custom = await styleStickerQr(original, { qrSource: "custom", qrBackgroundMode: "match" }, "#eeeeee");
  assert.deepEqual(await sharp(Buffer.from(custom.split(",")[1], "base64")).raw().toBuffer(),
    await sharp(Buffer.from(original.split(",")[1], "base64")).removeAlpha().raw().toBuffer());
  const transparent = await QRCode.toBuffer(target, { width: 300, margin: 4, color: { dark: "#000000ff", light: "#ffffff00" } });
  assert.equal(await decoded(await styleStickerQr(await normalizeCustomQr(transparent), { qrSource: "custom", qrBackgroundMode: "match" }, "#eeeeee")), target);
});
test("custom media reads are tenant-scoped and missing media is explicit", async () => {
  const uri = await normalizeCustomQr(await bytes());
  const db: any = { collection: () => ({ findOne: async (q: any) => q.shopId === 42 && q._id === "sticker-custom-qr:42" && q.type === "sticker_custom_qr" ? { dataUri: uri } : null }) };
  assert.equal(await customStickerQr(db, 42), uri);
  await assert.rejects(customStickerQr(db, 43), /explicitly switch/);
});
test("enterprise template copies cannot activate or distribute location-specific custom QR", () => {
  const snapshot = snapshotEnterpriseSettings({ stickerConfig: { qrSource: "custom", qrBackgroundMode: "match", customQrAsset: "other-shop" } }, ["stickers"]);
  const update = buildEnterpriseSettingsReplacement(snapshot, ["stickers"]);
  assert.ok(!Object.keys(update).some(key => /qrSource|qrBackgroundMode|customQr/i.test(key)));
});
test("rectangular uploaded artwork keeps full dimensions and border", async () => {
  const rectangular = await sharp(await bytes()).extend({ left: 70, right: 30, top: 0, bottom: 0, background: "white" }).png().toBuffer();
  const normalized = await normalizeCustomQr(rectangular);
  const meta = await sharp(Buffer.from(normalized.split(",")[1], "base64")).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 300);
  assert.equal(await decoded(normalized), target);
});
test("real standard/designer PNGs decode and mobile PDF embeds rendered output", async () => {
  const qr = await styleStickerQr(await normalizeCustomQr(await bytes()), { qrBackgroundMode: "match" }, "#eeeeee");
  const png = await renderStickerDesigner({ canvasWidth: 200, canvasHeight: 200, backgroundColor: "#eeeeee",
    elements: [{ type: "qrCode", visible: true, x: 10, y: 10, width: 180, height: 180, fontSize: 12, fontWeight: "normal", fontStyle: "normal", textAlign: "left", color: "#000000" }] },
  { qrDataUrl: qr, formattedDate: "", formattedMileage: "", distanceUnit: "mi" }, { width: 600, height: 600 });
  assert.equal(await decoded(png), target);
  const standard = await renderStickerStandard({ colors: { background: "#eeeeee" } }, { nextServiceDate: "", nextServiceMileage: 0, qrDataUrl: qr }, { width: 600, height: 600 });
  assert.equal(await decoded(standard), target);
  const pdf = await pngBufferToSizedPdfBuffer(png, 2, 2);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
});
