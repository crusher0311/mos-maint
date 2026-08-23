/**
 * Image decoding helpers.
 *
 * The cloud hands the agent a base64-encoded JPEG (optionally wrapped in a
 * data URI). This module turns that into the raw Buffer we write to the
 * printer socket after the XML header.
 */

import { decode as decodeJpeg } from "jpeg-js";
import {
  MAX_ENCODED_IMAGE_CHARS,
  MAX_IMAGE_INPUT_CHARS,
  MAX_JPEG_BYTES,
} from "./limits";

const DATA_URI_RE = /^data:([\w/+.-]+);base64,(.*)$/s;

/**
 * Fully decode the image before any DNS lookup or LAN connection. Marker-only
 * validation is insufficient: a payload can contain SOI/SOS/EOI while having
 * no valid frame or entropy data. jpeg-js validates the frame, tables, scan,
 * and entropy stream; strict resource limits keep hostile cloud data bounded.
 */
export function assertValidJpeg(buf: Buffer): void {
  if (
    buf.length < 4 ||
    buf[0] !== 0xff ||
    buf[1] !== 0xd8 ||
    buf[buf.length - 2] !== 0xff ||
    buf[buf.length - 1] !== 0xd9
  ) {
    throw new Error("image payload is not a valid JPEG (missing SOI/EOI markers)");
  }
  if (buf.length > MAX_JPEG_BYTES) {
    throw new Error("image payload is not a valid JPEG (file exceeds 4 MiB limit)");
  }

  try {
    const decoded = decodeJpeg(buf, {
      useTArray: true,
      formatAsRGBA: false,
      tolerantDecoding: false,
      maxResolutionInMP: 8,
      maxMemoryUsageInMB: 32,
    });
    if (
      !Number.isSafeInteger(decoded.width) ||
      decoded.width <= 0 ||
      !Number.isSafeInteger(decoded.height) ||
      decoded.height <= 0 ||
      decoded.data.length === 0
    ) {
      throw new Error("decoded image has invalid dimensions");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`image payload is not a valid JPEG (${detail})`);
  }
}

/** True when the buffer satisfies the structural JPEG checks above. */
export function isJpeg(buf: Buffer): boolean {
  try {
    assertValidJpeg(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a base64 string (bare or data-URI wrapped) into a Buffer.
 *
 * Throws on empty, malformed-base64, or structurally invalid JPEG input.
 * Invalid bytes are rejected before address resolution or socket creation.
 */
export function base64ToImageBuffer(input: string): Buffer {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("image payload is empty");
  }
  if (input.length > MAX_IMAGE_INPUT_CHARS) {
    throw new Error("image payload exceeds encoded size limit");
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
  if (b64.length > MAX_ENCODED_IMAGE_CHARS) {
    throw new Error("image payload exceeds encoded size limit");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) {
    throw new Error("image payload is not valid base64");
  }

  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) {
    throw new Error("image payload decoded to zero bytes");
  }
  assertValidJpeg(buf);
  return buf;
}
