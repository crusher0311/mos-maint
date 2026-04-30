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

// Wrap a rendered sticker PNG in a single-page PDF whose page size exactly
// matches the requested physical sticker dimensions. The image fills the
// page edge-to-edge with zero margins so AirPrint shows a real-size sheet
// instead of a tiny thumbnail floating inside a default letter page.
export async function pngBufferToSizedPdfBuffer(
  pngBuffer: Buffer | Uint8Array,
  widthIn: number,
  heightIn: number,
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const png = await pdfDoc.embedPng(pngBuffer);
  const widthPt = widthIn * PDF_POINTS_PER_INCH;
  const heightPt = heightIn * PDF_POINTS_PER_INCH;
  const page = pdfDoc.addPage([widthPt, heightPt]);
  page.drawImage(png, { x: 0, y: 0, width: widthPt, height: heightPt });
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
