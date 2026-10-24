import sharp from "sharp";
import jsQR from "jsqr";
import type { Db } from "mongodb";
import { resolveQrBackground, type StickerQrPreferences } from "./sticker-qr-appearance";

export const MAX_QR_BYTES = 500 * 1024;
const MAX_PIXELS = 2048 * 2048;
export class StickerQrError extends Error {}

export async function normalizeCustomQr(bytes: Buffer): Promise<string> {
  if (!bytes.length || bytes.length > MAX_QR_BYTES) throw new StickerQrError("Choose a QR image under 500KB.");
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false });
    const meta = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(meta.format || "") || (meta.pages || 1) > 1 ||
        !meta.width || !meta.height || meta.width > 2048 || meta.height > 2048) {
      throw new Error("unsupported");
    }
    const png = await image.rotate().png().toBuffer();
    const { data, info } = await sharp(png).flatten({ background: "#ffffff" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (!jsQR(new Uint8ClampedArray(data), info.width, info.height)) {
      throw new StickerQrError("No readable QR code found. Upload a clear image with its full quiet zone (blank border).");
    }
    if (png.length > MAX_QR_BYTES) throw new StickerQrError("Normalized image exceeds 500KB. Choose a smaller image.");
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch (error) {
    if (error instanceof StickerQrError) throw error;
    throw new StickerQrError("Upload a readable PNG, JPEG or WebP QR image no larger than 2048 × 2048 pixels.");
  }
}

export async function customStickerQr(db: Db, shopId: number): Promise<string> {
  const media = await db.collection("shop_media").findOne({ _id: `sticker-custom-qr:${shopId}` as any, shopId, type: "sticker_custom_qr" });
  if (!media?.dataUri || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(media.dataUri)) {
    throw new StickerQrError("Custom QR image is unavailable. Upload it again or explicitly switch to MOS-generated QR in sticker settings.");
  }
  return media.dataUri;
}

/** Apply appearance to a copy, never to the generated identity cache. Opaque
 * custom pixels are never recolored. Transparency is flattened safely. */
export async function styleStickerQr(dataUri: string, prefs: StickerQrPreferences, background?: string): Promise<string> {
  if (prefs.qrSource !== "custom" && prefs.qrBackgroundMode !== "match") return dataUri;
  const color = resolveQrBackground(prefs.qrBackgroundMode, background).color;
  const bytes = Buffer.from(dataUri.split(",")[1], "base64");
  if (prefs.qrSource === "custom") {
    const png = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).flatten({ background: color }).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  }
  // Replace only neutral near-white pixels, preserving dark modules, geometry,
  // logos and the existing quiet zone. Never re-encode the QR payload.
  const { data, info } = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).flatten({ background: "#ffffff" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  for (let i = 0; i < data.length; i += 4) {
    if (Math.min(data[i], data[i + 1], data[i + 2]) >= 245 &&
        Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) <= 3) {
      [data[i], data[i + 1], data[i + 2]] = rgb;
    }
  }
  const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}
