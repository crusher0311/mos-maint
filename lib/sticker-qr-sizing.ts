import jsQR from "jsqr";
import { getStickerSize, type StickerElement, type StickerLayout } from "./sticker-designer-types";
import { STICKER_PDF_SAFE_MARGIN_IN } from "./sticker-print-dimensions";

// Advisory, not a scan guarantee: ~3 printer dots at 203 dpi.
export const MIN_QR_MODULE_MM = 0.4;
type Point = { x: number; y: number };
export interface QrArtworkGeometry {
  width: number;
  height: number;
  modules: number;
  corners: Point[];
}

/** Inspect a copy of the pixels. Payloads are neither retained nor rewritten. */
export function inspectQrPixels(pixels: Uint8ClampedArray, width: number, height: number): QrArtworkGeometry | null {
  const code = jsQR(pixels, width, height);
  if (!code) return null;
  return {
    width, height, modules: 17 + 4 * code.version,
    corners: [code.location.topLeftCorner, code.location.topRightCorner,
      code.location.bottomRightCorner, code.location.bottomLeftCorner],
  };
}

export function qrSizingWarnings(
  layout: StickerLayout, size: string, element: StickerElement,
  artwork: QrArtworkGeometry | null,
): string[] {
  if (!element.visible || element.type !== "qrCode") return [];
  const warnings: string[] = [];
  const label = getStickerSize(size);
  // Mirror the renderer's independent canvas scales, then its contain-fit.
  const sx = label.widthInches / layout.canvasWidth;
  const sy = label.heightInches / layout.canvasHeight;
  const box = { x: element.x * sx, y: element.y * sy, w: element.width * sx, h: element.height * sy };
  if (!artwork) {
    warnings.push("QR size could not be verified from this image. Use a clear QR image and test a printed label.");
    if (box.x < 0 || box.y < 0 || box.x + box.w > label.widthInches || box.y + box.h > label.heightInches) {
      warnings.push("QR artwork extends beyond the printable label and may be clipped. Move it inside the label.");
    }
    return warnings;
  }
  const scale = Math.min(box.w / artwork.width, box.h / artwork.height);
  const x = box.x + (box.w - artwork.width * scale) / 2;
  const y = box.y + (box.h - artwork.height * scale) / 2;
  const edges = artwork.corners.map((p, i) => {
    const next = artwork.corners[(i + 1) % 4];
    return Math.hypot(next.x - p.x, next.y - p.y);
  });
  const modulePixels = Math.min(...edges) / artwork.modules;
  const pdfScale = Math.min(
    (label.widthInches - 2 * STICKER_PDF_SAFE_MARGIN_IN) / label.widthInches,
    (label.heightInches - 2 * STICKER_PDF_SAFE_MARGIN_IN) / label.heightInches,
  );
  const moduleMm = modulePixels * scale * pdfScale * 25.4;
  if (moduleMm < MIN_QR_MODULE_MM) {
    warnings.push(`QR modules may print too small (${moduleMm.toFixed(2)} mm; aim for at least ${MIN_QR_MODULE_MM.toFixed(2)} mm). Enlarge the QR box; padding in uploaded artwork reduces the usable code size.`);
  }
  // Four-module quiet zone, including rotated artwork. Use the longest
  // detected module edge conservatively for mildly distorted uploads.
  const quiet = Math.max(...edges) / artwork.modules * 4;
  const left = Math.min(...artwork.corners.map(p => p.x)) - quiet;
  const right = Math.max(...artwork.corners.map(p => p.x)) + quiet;
  const top = Math.min(...artwork.corners.map(p => p.y)) - quiet;
  const bottom = Math.max(...artwork.corners.map(p => p.y)) + quiet;
  // Decoder corners can differ from raster edges by fractions of a pixel.
  const tolerance = 1;
  if (left < -tolerance || top < -tolerance || right > artwork.width + tolerance || bottom > artwork.height + tolerance) {
    warnings.push("QR artwork may not have a full four-module blank border. Use artwork with a complete quiet zone.");
  }
  if (x + left * scale < -1e-6 || y + top * scale < -1e-6 ||
      x + right * scale > label.widthInches + 1e-6 || y + bottom * scale > label.heightInches + 1e-6) {
    warnings.push("The QR code or its blank border extends beyond the printable label and may be clipped. Move it inside the label.");
  }
  return warnings;
}
