import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValidJpeg, base64ToImageBuffer, isJpeg } from "../src/image";
import { MAX_IMAGE_INPUT_CHARS } from "../src/limits";
import { VALID_JPEG_BASE64, VALID_JPEG_BYTES } from "./fixtures/jpeg";

const JPEG_BYTES = VALID_JPEG_BYTES;
const JPEG_B64 = VALID_JPEG_BASE64;
const MARKER_ONLY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0x00, 0xff, 0xd9,
]);

test("base64ToImageBuffer decodes a bare base64 string", () => {
  const out = base64ToImageBuffer(JPEG_B64);
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual(out, JPEG_BYTES);
});

test("base64ToImageBuffer strips a data: URI prefix", () => {
  const dataUri = `data:image/jpeg;base64,${JPEG_B64}`;
  const out = base64ToImageBuffer(dataUri);
  assert.deepEqual(out, JPEG_BYTES);
});

test("base64ToImageBuffer tolerates whitespace/newlines in payload", () => {
  const chunked = JPEG_B64.replace(/(.{2})/g, "$1\n");
  const out = base64ToImageBuffer(chunked);
  assert.deepEqual(out, JPEG_BYTES);
});

test("base64ToImageBuffer throws on empty input", () => {
  assert.throws(() => base64ToImageBuffer(""), /empty/);
  assert.throws(() => base64ToImageBuffer("   "), /empty/);
  assert.throws(() => base64ToImageBuffer("data:image/jpeg;base64,"), /no base64 data/);
});

test("isJpeg requires a structurally complete JPEG", () => {
  assert.equal(isJpeg(JPEG_BYTES), true);
  assert.equal(isJpeg(Buffer.from([0x89, 0x50])), false); // PNG-ish
  assert.equal(isJpeg(Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9])), false);
  assert.equal(isJpeg(MARKER_ONLY_JPEG), false);
  assert.equal(isJpeg(Buffer.alloc(0)), false);
});

test("base64ToImageBuffer rejects malformed or truncated JPEG payloads", () => {
  assert.throws(
    () => base64ToImageBuffer(Buffer.from("not a jpeg").toString("base64")),
    /not a valid JPEG/,
  );
  assert.throws(
    () => base64ToImageBuffer(JPEG_BYTES.subarray(0, -2).toString("base64")),
    /not a valid JPEG/,
  );
  assert.throws(() => base64ToImageBuffer("***"), /not valid base64/);
  assert.throws(
    () => base64ToImageBuffer(MARKER_ONLY_JPEG.toString("base64")),
    /not a valid JPEG/,
  );
  assert.doesNotThrow(() => assertValidJpeg(JPEG_BYTES));
});

test("base64ToImageBuffer rejects oversized encoded input before decode", () => {
  const oversized = "A".repeat(MAX_IMAGE_INPUT_CHARS + 1);
  assert.throws(() => base64ToImageBuffer(oversized), /encoded size limit/);
});
