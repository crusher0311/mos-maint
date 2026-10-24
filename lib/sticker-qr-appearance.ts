export interface StickerQrPreferences {
  qrSource?: "generated" | "custom";
  qrBackgroundMode?: "white" | "match";
}

/** Conservative print policy: every sRGB channel >= 224. Unknown CSS colors
 * and dark/saturated colors stay white. No changes to encoded destinations. */
export function resolveQrBackground(mode?: string, background?: string): { color: string; warning?: string } {
  if (mode !== "match") return { color: "#ffffff" };
  const hex = background?.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex && [0, 2, 4].every(i => parseInt(hex.slice(i, i + 2), 16) >= 224)) {
    return { color: `#${hex.toLowerCase()}` };
  }
  return { color: "#ffffff", warning: "This background is too dark or unsupported for reliable QR contrast. The QR background stays white." };
}

export function validQrPreferences(value: StickerQrPreferences): boolean {
  return (value.qrSource === undefined || ["generated", "custom"].includes(value.qrSource)) &&
    (value.qrBackgroundMode === undefined || ["white", "match"].includes(value.qrBackgroundMode));
}
