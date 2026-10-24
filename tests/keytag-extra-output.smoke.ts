import assert from "node:assert/strict";
import { loadImage, createCanvas } from "canvas";
import { PDFDocument } from "pdf-lib";
import { renderKeytagDesigner } from "../lib/canvas-renderer";
import { pngBufferToSizedPdfBuffer } from "../lib/sticker-pdf";
import { renderKeytagBuffer, toJpegBase64 } from "../lib/print-queue/render";
import { DEFAULT_LAYOUT, SAMPLE_DATA } from "../lib/keytag-designer-types";
import { resolvePaperSize } from "../lib/keytag-paper-sizes";
import { fitKeytagExtraFontSize, keytagExtraTextRuns } from "../lib/keytag-extra-fields";

async function main() {
  const layout = { ...DEFAULT_LAYOUT, elements: [{
    ...DEFAULT_LAYOUT.elements[0], id: "custom_output", type: "custom" as const,
    label: "Parking location", width: 150, height: 25, showLabel: true,
    labelFontWeight: "bold" as const, valueFontStyle: "italic" as const,
  }] };
  const long = "North overflow lot, row 12, near the blue entrance gate";
  const data = { ...SAMPLE_DATA, extraValues: { custom_output: long } } as any;
  for (const config of [{ presetId: "dymo_30252" }, { presetId: "brother_dk1202" },
    { presetId: "custom", custom: { width: 50, height: 30, dpi: 203, units: "mm" as const } }]) {
    const paper = resolvePaperSize(config);
    const sized = { ...layout, canvasWidth: paper.designWidth, canvasHeight: paper.designHeight, paperSize: config };
    const png = await renderKeytagDesigner(sized, data, paper.renderWidth, paper.renderHeight, 2);
    const image = await loadImage(png);
    assert.equal(image.width, paper.renderWidth * 2);
    assert.equal(image.height, paper.renderHeight * 2);
    assert.deepEqual(await renderKeytagBuffer({ designerLayout: sized }, data), png, "queue uses identical PNG render");
    const pdf = await PDFDocument.load(await pngBufferToSizedPdfBuffer(png, paper.widthIn, paper.heightIn));
    const page = pdf.getPage(0);
    assert.equal(page.getWidth(), paper.widthIn * 72);
    assert.equal(page.getHeight(), paper.heightIn * 72);
    const jpeg = await loadImage(Buffer.from(await toJpegBase64(png), "base64"));
    assert.equal(jpeg.width, image.width);
    assert.equal(jpeg.height, image.height);
    const blank = await renderKeytagDesigner(sized, { ...data, extraValues: {} }, paper.renderWidth, paper.renderHeight, 2);
    const hidden = await renderKeytagDesigner({ ...sized, elements: sized.elements.map(el => ({ ...el, visible: false })) },
      data, paper.renderWidth, paper.renderHeight, 2);
    assert.deepEqual(blank, hidden, "blank extras produce exactly the same PNG as hidden extras");
    assert.notDeepEqual(png, blank);
  }
  const ctx = createCanvas(1, 1).getContext("2d");
  const measure = (text: string, size: number, weight: string, style: string) => {
    ctx.font = `${style} ${weight} ${size}px Inter, Arial, Helvetica, sans-serif`;
    return ctx.measureText(text).width;
  };
  const el = layout.elements[0];
  const size = fitKeytagExtraFontSize(el, long, measure);
  const width = keytagExtraTextRuns(el, long).reduce((sum, run) => sum + measure(run.text, size, run.weight, run.style), 0);
  assert.ok(width <= el.width - 3.9 && size < el.fontSize);
  console.log("Native PNG, PDF dimensions, queue JPEG, blank suppression and long-value fitting passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
