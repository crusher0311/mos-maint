import { PDFDocument } from "pdf-lib";

// PDF coordinate space is points: 1 inch = 72 points (PDF spec, default
// user space). pdf-lib uses these units for page sizes and drawing.
export const PDF_POINTS_PER_INCH = 72;

// Physical sticker dimensions in inches, keyed by the size strings the
// sticker UI/API already uses ("2x2", "2x2.5", …). This is the
// authoritative inch-size mapping for the mobile PDF print path: iOS
// Safari/AirPrint ignore CSS `@page { size }` and default to letter, so the
// only reliable way to make a sticker print at its true size on iOS is to
// hand AirPrint a PDF whose embedded page size already matches the sticker.
export const STICKER_SIZE_INCHES: Record<string, { width: number; height: number }> = {
  "1.5x2.25": { width: 1.5, height: 2.25 },
  "2x2":      { width: 2.0, height: 2.0 },
  "2x2.5":    { width: 2.0, height: 2.5 },
  "2x3":      { width: 2.0, height: 3.0 },
  "2x3.5":    { width: 2.0, height: 3.5 },
};

export function getStickerSizeInches(size: string): { width: number; height: number } {
  return STICKER_SIZE_INCHES[size] || STICKER_SIZE_INCHES["2x2.5"];
}

// Quiet-zone safe margin (inches, per edge) baked into the mobile sticker PDF.
//
// Why: iOS hands the sized PDF to AirPrint, which applies its own
// "scale-to-fit" against the selected media and tends to OVERSHOOT — enlarging
// the page slightly so the design, which otherwise sits flush to the edge,
// gets clipped on Mac/iOS even though it prints correctly on Windows. By
// insetting the rendered image a hair inside the (still true-size) PDF page,
// any residual scale-up / printer non-printable border eats this whitespace
// instead of the artwork. The PDF *page* size is deliberately left untouched
// (== the true sticker size) so AirPrint reads the correct physical size.
//
// ~0.05" ≈ 1.3mm per edge: enough to absorb typical overshoot/hardware margin
// without visibly shrinking the sticker.
export const STICKER_PDF_SAFE_MARGIN_IN = 0.05;

// Wrap a rendered sticker PNG in a single-page PDF whose page size exactly
// matches the requested physical sticker dimensions.
//
// `marginIn` (per-edge, inches) insets the image inside the page as a quiet
// zone — see STICKER_PDF_SAFE_MARGIN_IN. With the default of 0 the image fills
// the page edge-to-edge (used by key tags and any caller that doesn't opt in),
// preserving the original behavior. Because the rendered PNG already matches
// the page aspect ratio, the contain-fit below reduces to an edge-to-edge fill
// when marginIn is 0.
export async function pngBufferToSizedPdfBuffer(
  pngBuffer: Buffer | Uint8Array,
  widthIn: number,
  heightIn: number,
  marginIn: number = 0,
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const png = await pdfDoc.embedPng(pngBuffer);
  const widthPt = widthIn * PDF_POINTS_PER_INCH;
  const heightPt = heightIn * PDF_POINTS_PER_INCH;
  const page = pdfDoc.addPage([widthPt, heightPt]);

  // Clamp the margin so it can never collapse the drawable area (at most a
  // quarter of the smaller side per edge).
  const maxMarginPt = Math.min(widthPt, heightPt) / 4;
  const marginPt = Math.max(0, Math.min(marginIn * PDF_POINTS_PER_INCH, maxMarginPt));

  const innerW = widthPt - marginPt * 2;
  const innerH = heightPt - marginPt * 2;

  // Contain the image within the inner rect, preserving aspect ratio, then
  // center it on the full page. Equal margins on all sides.
  const imgW = png.width;
  const imgH = png.height;
  const scale = Math.min(innerW / imgW, innerH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const x = (widthPt - drawW) / 2;
  const y = (heightPt - drawH) / 2;

  page.drawImage(png, { x, y, width: drawW, height: drawH });
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
