/** Shared by the PDF print path and browser-side physical-size checks. */
export const STICKER_PDF_SAFE_MARGIN_IN = 0.05;

// Nominal media dimensions, independent of raster resolution or driver scaling.
export const STICKER_SIZE_INCHES: Record<string, { width: number; height: number }> = {
  "1.5x2.25": { width: 1.5, height: 2.25 },
  "2x2": { width: 2, height: 2 },
  "2x2.5": { width: 2, height: 2.5 },
  "2x3": { width: 2, height: 3 },
  "2x3.5": { width: 2, height: 3.5 },
};

export function getStickerSizeInches(size: string): { width: number; height: number } {
  return STICKER_SIZE_INCHES[size] || STICKER_SIZE_INCHES["2x2.5"];
}
