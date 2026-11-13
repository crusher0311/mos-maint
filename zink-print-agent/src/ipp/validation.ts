import { validateStock, type Stock } from "./media";

/** Pure cloud/agent validation: never import LAN transport or discovery here. */
export function supportedModel(model: string, kind: "sticker" | "keytag"): boolean {
  return kind === "sticker" && /\bzink\b.*\bhappy\b/i.test(model);
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function validatePng(png: Buffer, requested: Stock): void {
  validateStock(requested);
  if (png.length < 45 || png.length > 4 * 1024 * 1024 ||
      !png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    throw new Error("Expected a PNG of at most 4 MiB");
  let pos = 8, width = 0, height = 0, image = false, end = false;
  while (pos < png.length) {
    if (pos + 12 > png.length) throw new Error("Truncated PNG");
    const length = png.readUInt32BE(pos), type = png.toString("ascii", pos + 4, pos + 8);
    if (pos + length + 12 > png.length) throw new Error("Truncated PNG chunk");
    if (crc32(png.subarray(pos + 4, pos + 8 + length)) !== png.readUInt32BE(pos + 8 + length))
      throw new Error("Invalid PNG checksum");
    if (pos === 8 && (type !== "IHDR" || length !== 13)) throw new Error("Missing PNG header");
    if (type === "IHDR") {
      if (pos !== 8) throw new Error("Repeated PNG header");
      width = png.readUInt32BE(pos + 8); height = png.readUInt32BE(pos + 12);
      if (!width || !height || width > 10000 || height > 10000 || width * height > 16000000)
        throw new Error("PNG dimensions exceed limits");
    }
    if (type === "acTL") throw new Error("Animated PNG is unsupported");
    if (type === "IDAT") image = true;
    pos += length + 12;
    if (type === "IEND") {
      if (length || pos !== png.length) throw new Error("Invalid PNG end");
      end = true;
    }
  }
  if (!image || !end) throw new Error("Incomplete PNG");
  if (Math.abs(width * requested.height - height * requested.width) >
      Math.min(Math.max(requested.width, requested.height), width * requested.height * 0.005))
    throw new Error("PNG aspect ratio disagrees with physical dimensions");
}
