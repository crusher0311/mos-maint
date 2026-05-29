import { test } from "node:test";
import assert from "node:assert/strict";
import { base64ToImageBuffer, isJpeg } from "../src/image";

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const JPEG_B64 = JPEG_BYTES.toString("base64");

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

test("isJpeg detects the SOI marker", () => {
  assert.equal(isJpeg(JPEG_BYTES), true);
  assert.equal(isJpeg(Buffer.from([0x89, 0x50])), false); // PNG-ish
  assert.equal(isJpeg(Buffer.alloc(0)), false);
});
