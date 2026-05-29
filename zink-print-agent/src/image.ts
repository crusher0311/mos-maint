/**
 * Image decoding helpers.
 *
 * The cloud hands the agent a base64-encoded JPEG (optionally wrapped in a
 * data URI). This module turns that into the raw Buffer we write to the
 * printer socket after the XML header.
 */

const DATA_URI_RE = /^data:([\w/+.-]+);base64,(.*)$/s;

/** True if the buffer starts with the JPEG Start-Of-Image marker (FF D8). */
export function isJpeg(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

/**
 * Convert a base64 string (bare or data-URI wrapped) into a Buffer.
 *
 * Throws on empty input or input that does not decode to any bytes. The
 * JPEG magic-byte check is intentionally a soft warning path: callers that
 * care can use `isJpeg()` directly. Hardware is the source of truth for
 * what it accepts, so we don't hard-reject non-JPEG here.
 */
export function base64ToImageBuffer(input: string): Buffer {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("image payload is empty");
  }

  let b64 = input.trim();
  const match = b64.match(DATA_URI_RE);
  if (match) {
    b64 = match[2];
  }
  // Strip any whitespace/newlines that may have crept into the base64.
  b64 = b64.replace(/\s+/g, "");

  if (b64 === "") {
    throw new Error("image payload contained no base64 data");
  }

  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) {
    throw new Error("image payload decoded to zero bytes");
  }
  return buf;
}
