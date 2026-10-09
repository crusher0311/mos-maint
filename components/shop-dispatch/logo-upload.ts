export const MAX_LOGO_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_LOGO_BYTES = 120 * 1024;
export const MAX_LOGO_DATA_URL_CHARS = 180000;
const MAX_EDGE = 8192;
const MAX_PIXELS = 24 * 1024 * 1024;
type RasterType = "image/png" | "image/jpeg" | "image/webp";

export function validateLogoFile(size: number, type: string): asserts type is RasterType {
  if (!["image/png", "image/jpeg", "image/webp"].includes(type)) {
    throw new Error("Choose a PNG, JPEG or WebP image. SVGs and other file types are not supported.");
  }
  if (!size || size > MAX_LOGO_UPLOAD_BYTES) throw new Error("Choose a non-empty image up to 10 MB. Export a smaller copy and try again.");
}

export function validateLogoDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
    width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    throw new Error("This image is too large to safely process. Export a copy no larger than 8192 pixels on either side and 24 megapixels total.");
  }
}

/** Read raster dimensions before asking the browser to allocate decoded pixels. */
export function logoDimensions(bytes: Uint8Array, type: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  let width = 0, height = 0;
  if (type === "image/png" && bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) && text(12, 16) === "IHDR") {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda || marker === undefined) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += length;
    }
  } else if (type === "image/webp" && bytes.length >= 30 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") {
    const chunk = text(12, 16);
    if (chunk === "VP8X") {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (chunk === "VP8L" && bytes[20] === 0x2f) {
      width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0xf) << 10);
    } else if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
    }
  }
  if (!width || !height) throw new Error("The image is damaged or does not match its PNG, JPEG or WebP file type. Export a fresh raster copy and try again.");
  validateLogoDimensions(width, height);
  return { width, height };
}

export function logoFitsPayload(binaryBytes: number, dataUrlLength: number): boolean {
  return binaryBytes > 0 && binaryBytes <= MAX_LOGO_BYTES && dataUrlLength <= MAX_LOGO_DATA_URL_CHARS;
}

export async function prepareLogo(file: File, progress: (message: string) => void) {
  validateLogoFile(file.size, file.type);
  progress("Checking image dimensions…");
  logoDimensions(new Uint8Array(await file.arrayBuffer()), file.type);
  const url = URL.createObjectURL(file);
  try {
    progress("Decoding image…");
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => { throw new Error("Your browser could not decode this image. Export a fresh PNG, JPEG or WebP and try again."); });
    validateLogoDimensions(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable in this browser. Try a current browser.");
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    let width = Math.max(1, Math.round(image.naturalWidth * scale));
    let height = Math.max(1, Math.round(image.naturalHeight * scale));
    // PNG and WebP never pass through JPEG, so transparent backgrounds stay transparent.
    const type = file.type === "image/jpeg" ? "image/jpeg" : file.type === "image/webp" ? "image/webp" : "image/png";
    for (let attempt = 0; attempt < 16; attempt++) {
      progress(`Resizing logo · ${width} × ${height} pixels…`);
      canvas.width = width; canvas.height = height;
      context.drawImage(image, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        value => value ? resolve(value) : reject(new Error("Could not encode the logo. Export a fresh raster copy and try again.")),
        type, Math.max(0.55, 0.9 - attempt * 0.07),
      ));
      if (blob.size <= MAX_LOGO_BYTES) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("Could not read the resized logo. Please try again."));
          reader.readAsDataURL(blob);
        });
        if (logoFitsPayload(blob.size, dataUrl.length)) return { dataUrl, width, height, bytes: blob.size };
      }
      width = Math.max(1, Math.floor(width * 0.75)); height = Math.max(1, Math.floor(height * 0.75));
    }
    throw new Error("Could not fit this logo within the saved-image limit. Try a simpler image or a smaller export.");
  } finally { URL.revokeObjectURL(url); }
}
