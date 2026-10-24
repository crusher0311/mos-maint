import colorString from "color-string";

// Keep legacy CSS colors (named, hex, rgb[a], hsl[a]) without rewriting
// stored layouts. Exclude contextual CSS such as var()/currentColor and URLs.
export function validStickerColor(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  const parsed = colorString.get(value.trim().toLowerCase());
  // node-canvas does not support HWB, unlike modern browsers.
  return parsed !== null && parsed.model !== "hwb";
}
