import { createHash } from "node:crypto";
import sharp from "sharp";
import { isRasterLogo } from "./model";
import { paletteFromPixels, type SharedBrand } from "./branding";

type Result = Pick<SharedBrand, "logo" | "colors">;
const cache = new Map<string, Promise<Result>>();
const empty: Result = { logo: null, colors: null };
/** Embedded raster only: never pass URLs/paths/SVG to the decoder. Bounded
 * bytes, pixels, time, output and cache; rejected images are cached too. */
export async function readLogoPalette(value: unknown): Promise<Result> {
  if (typeof value !== "string" || value.length > 700000 || !isRasterLogo(value)) return empty;
  const key = createHash("sha256").update(value).digest("hex");
  const hit = cache.get(key);
  if (hit) return hit;
  // Also cap concurrent work; no unbounded waiting queue on many new logos.
  if (active >= 2) return empty;
  const pending = decode(value);
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, pending);
  return pending;
}
let active = 0;
async function decode(value: string): Promise<Result> {
  active++;
  try {
    const bytes = Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
    if (bytes.length > 500 * 1024) return empty;
    const data = await sharp(bytes, { limitInputPixels: 4_000_000, pages: 1, failOn: "warning" })
      .timeout({ seconds: 2 }).resize(48, 48, { fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb").ensureAlpha().raw().toBuffer();
    return { logo: value, colors: paletteFromPixels(data) };
  } catch {
    return empty;
  } finally {
    active--;
  }
}
