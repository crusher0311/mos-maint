import assert from "node:assert/strict";
import { createCanvas, loadImage } from "canvas";
import { PDFDocument } from "pdf-lib";
import { createDefaultLayout, scaleLayoutToSize, STICKER_SIZES, validStickerLayout } from "../lib/sticker-designer-types";
import { paintStickerText } from "../lib/sticker-text-painter";
import { renderStickerDesigner } from "../lib/canvas-renderer";
import { pngBufferToSizedPdfBuffer } from "../lib/sticker-pdf";

async function main() {
  const layout = createDefaultLayout();
  const el = { ...layout.elements.find(e => e.type === "serviceLabel")!,
    id: "custom", type: "text" as const, content: "Thank you for choosing our shop — very long text",
    x: 0, y: 0, width: 100, height: 24, underline: true, borderColor: "#ff0000",
    borderWidth: 2, backgroundColor: "#ffff00", fontWeight: "bold" as const, fontStyle: "italic" as const };
  layout.elements.push(el);
  assert.ok(validStickerLayout(layout));
  assert.deepEqual(JSON.parse(JSON.stringify(layout)), layout);
  for (const color of ["red", "rebeccapurple", "transparent", "rgb(12, 34, 56)", "hsl(180, 50%, 50%)", "#ff000080"]) {
    const legacy = { ...layout, elements: [{ ...el, color, backgroundColor: color, borderColor: color }] };
    assert.ok(validStickerLayout(legacy), color);
    assert.deepEqual(JSON.parse(JSON.stringify(legacy)), legacy);
  }
  for (const patch of [{ borderWidth: 5 }, { borderWidth: -1 }, { borderColor: "url(x)" },
    { backgroundColor: "invalid" }, { underline: "yes" }, { content: "a\nb" },
    { content: "x".repeat(201) }, { width: Infinity }]) {
    assert.equal(validStickerLayout({ ...layout, elements: [{ ...el, ...patch }] }), false);
  }
  assert.equal(validStickerLayout({ ...layout, elements: Array.from({length: 13}, (_, i) => ({ ...el, id: `t${i}` })) }), false);
  assert.equal(validStickerLayout({ ...layout, elements: [el, el] }), false);
  for (const size of STICKER_SIZES) {
    const resized = scaleLayoutToSize(layout, size.value);
    assert.ok(validStickerLayout(resized));
    const custom = resized.elements.at(-1)!;
    assert.equal(custom.content, el.content);
    assert.equal(custom.underline, true);
    assert.equal(custom.borderWidth, 2 * Math.min(size.canvasWidth / 200, size.canvasHeight / 200));
    const png = await renderStickerDesigner(resized, { formattedDate: "", formattedMileage: "", distanceUnit: "mi" }, { width: size.renderWidth, height: size.renderHeight }, 1);
    const img = await loadImage(png);
    assert.equal(img.width, size.renderWidth);
    assert.equal(img.height, size.renderHeight);
    const pdf = await PDFDocument.load(await pngBufferToSizedPdfBuffer(png, size.widthInches, size.heightInches));
    assert.equal(pdf.getPage(0).getWidth(), size.widthInches * 72);
    assert.equal(pdf.getPage(0).getHeight(), size.heightInches * 72);
  }
  // Pixel agreement of the common browser painter with the real export renderer.
  // Oversized glyphs must not escape the element into neighboring content.
  const tall = { ...el, fontSize: 36, height: 20, y: 20, content: "Oversized gj" };
  const preview = createCanvas(100, 20), previewCtx = preview.getContext("2d");
  paintStickerText(previewCtx, tall.content, tall);
  const exported = await renderStickerDesigner({ canvasWidth: 100, canvasHeight: 60, backgroundColor: "#ffffff", elements: [tall] },
    { formattedDate: "", formattedMileage: "", distanceUnit: "mi" }, { width: 100, height: 60 }, 1);
  const full = createCanvas(100, 60), fullCtx = full.getContext("2d");
  fullCtx.drawImage(await loadImage(exported), 0, 0);
  assert.deepEqual(fullCtx.getImageData(0, 20, 100, 20).data, previewCtx.getImageData(0, 0, 100, 20).data);
  for (const y of [0, 40]) assert.ok(fullCtx.getImageData(0, y, 100, 20).data.every(v => v === 255));
  for (const textAlign of ["left", "center", "right"] as const) {
    for (const content of ["Short", el.content, ""]) {
      const element = { ...el, textAlign, content };
      const canvas = createCanvas(100, 24), ctx = canvas.getContext("2d");
      paintStickerText(ctx, content, element);
      const png = await renderStickerDesigner({ canvasWidth: 100, canvasHeight: 24, backgroundColor: "#ffffff", elements: [element] },
        { formattedDate: "", formattedMileage: "", distanceUnit: "mi" }, { width: 100, height: 24 }, 1);
      const output = createCanvas(100, 24), out = output.getContext("2d");
      out.drawImage(await loadImage(png), 0, 0);
      assert.deepEqual(out.getImageData(0, 0, 100, 24).data, ctx.getImageData(0, 0, 100, 24).data);
    }
  }
  console.log("Sticker formatting: validation, roundtrip, sizes, shared painting, PNG and physical PDF dimensions passed.");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
