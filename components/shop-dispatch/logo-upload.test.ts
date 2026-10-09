import assert from "node:assert/strict";
import { test } from "node:test";
import { logoDimensions, logoFitsPayload, MAX_LOGO_BYTES, MAX_LOGO_UPLOAD_BYTES, prepareLogo, validateLogoDimensions, validateLogoFile } from "./logo-upload";

function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}
test("uploads allow raster files above the old cap up to 10 MB", () => {
  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    assert.doesNotThrow(() => validateLogoFile(MAX_LOGO_UPLOAD_BYTES, type));
    assert.throws(() => validateLogoFile(MAX_LOGO_UPLOAD_BYTES + 1, type), /10 MB/);
  }
  assert.throws(() => validateLogoFile(0, "image/png"));
  assert.throws(() => validateLogoFile(123, "image/svg+xml"), /SVG/);
  assert.throws(() => validateLogoFile(123, "image/gif"));
});
test("PNG headers are validated before decode, including sliced buffers", () => {
  assert.deepEqual(logoDimensions(png(1400, 800), "image/png"), { width: 1400, height: 800 });
  const container = new Uint8Array(32); container.set(png(200, 100), 8);
  assert.deepEqual(logoDimensions(container.subarray(8), "image/png"), { width: 200, height: 100 });
  assert.throws(() => logoDimensions(png(9000, 100), "image/png"), /too large/);
  assert.throws(() => logoDimensions(png(6000, 6000), "image/png"), /too large/);
  assert.throws(() => logoDimensions(png(0, 100), "image/png"));
  assert.throws(() => logoDimensions(png(100, 100), "image/jpeg"), /does not match/);
});
test("JPEG baseline and progressive frame dimensions are supported", () => {
  for (const marker of [0xc0, 0xc2]) {
    const bytes = Uint8Array.from([255, 216, 255, marker, 0, 8, 8, 0, 80, 0, 120, 1]);
    assert.deepEqual(logoDimensions(bytes, "image/jpeg"), { width: 120, height: 80 });
  }
  assert.throws(() => logoDimensions(Uint8Array.from([255, 216, 255, 224, 255, 255]), "image/jpeg"));
});
test("WebP extended, lossless and lossy frame dimensions are supported", () => {
  const header = (chunk: string) => {
    const bytes = new Uint8Array(30);
    for (const [offset, text] of [[0, "RIFF"], [8, "WEBP"], [12, chunk]] as const) bytes.set(Array.from(text, char => char.charCodeAt(0)), offset);
    return bytes;
  };
  const extended = header("VP8X"); extended[24] = 119; extended[27] = 79;
  const lossless = header("VP8L"); lossless[20] = 0x2f; lossless[21] = 119; lossless[22] = 0xc0; lossless[23] = 19;
  const lossy = header("VP8 "); lossy.set([0x9d, 1, 0x2a, 120, 0, 80, 0], 23);
  for (const bytes of [extended, lossless, lossy]) assert.deepEqual(logoDimensions(bytes, "image/webp"), { width: 120, height: 80 });
});
test("truncated or unsupported data and unreasonable decoded dimensions fail safely", () => {
  for (const type of ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]) {
    assert.throws(() => logoDimensions(new Uint8Array(3), type));
  }
  for (const [width, height] of [[0, 1], [1, -1], [Infinity, 20], [8193, 1], [8192, 8192]]) {
    assert.throws(() => validateLogoDimensions(width, height));
  }
  assert.doesNotThrow(() => validateLogoDimensions(1024, 1024));
});
test("encoded output must meet BOTH unchanged server limits", () => {
  assert.equal(logoFitsPayload(MAX_LOGO_BYTES, 180000), true);
  assert.equal(logoFitsPayload(MAX_LOGO_BYTES + 1, 160000), false);
  assert.equal(logoFitsPayload(MAX_LOGO_BYTES, 180001), false);
  assert.equal(logoFitsPayload(0, 20), false);
});

test("offline browser doubles exercise resize, transparent encoding, progress and URL cleanup", async () => {
  const originals = new Map(["Image", "document", "FileReader"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL;
  const encodes: { width: number; height: number; type: string }[] = [];
  const progress: string[] = [];
  let revoked = false, failDecode = false;
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: () => undefined }),
    toBlob: (callback: (blob: Blob) => void, type: string) => {
      encodes.push({ width: canvas.width, height: canvas.height, type });
      callback(new Blob([new Uint8Array(encodes.length === 1 ? MAX_LOGO_BYTES + 1 : 50000)], { type }));
    },
  };
  class TestImage {
    src = ""; naturalWidth = 2000; naturalHeight = 1000;
    async decode() { if (failDecode) throw new Error("decode failed"); }
  }
  class TestReader {
    result = ""; onload?: () => void;
    readAsDataURL(blob: Blob) {
      void blob.arrayBuffer().then(bytes => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
        this.onload?.();
      });
    }
  }
  try {
    Object.defineProperty(globalThis, "Image", { configurable: true, value: TestImage });
    Object.defineProperty(globalThis, "FileReader", { configurable: true, value: TestReader });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => canvas } });
    URL.createObjectURL = () => "blob:offline-logo";
    URL.revokeObjectURL = () => { revoked = true; };
    const file = new Blob([png(2000, 1000)], { type: "image/png" }) as File;
    const result = await prepareLogo(file, message => progress.push(message));
    assert.deepEqual(encodes, [
      { width: 1024, height: 512, type: "image/png" },
      { width: 768, height: 384, type: "image/png" },
    ]);
    assert.equal(result.bytes, 50000);
    assert.equal(logoFitsPayload(result.bytes, result.dataUrl.length), true);
    assert.ok(result.dataUrl.startsWith("data:image/png;base64,"));
    assert.ok(progress.some(message => message.includes("Decoding")));
    assert.ok(progress.some(message => message.includes("768")));
    assert.equal(revoked, true);
    failDecode = true; revoked = false;
    await assert.rejects(prepareLogo(file, () => undefined), /could not decode/);
    assert.equal(revoked, true);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl;
  }
});
