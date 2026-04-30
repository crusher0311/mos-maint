/**
 * Regression smoke test for Task #219 — mobile sticker printing.
 *
 * Run: `npx tsx tests/plan-build-task-219.smoke.ts`
 *
 * Background
 * ----------
 * On iOS Safari the Quick Sticker print preview rendered the sticker as a
 * tiny image in the corner of an 8.5"x11" letter sheet because iOS
 * Safari/AirPrint *ignore* CSS `@page { size }` and use whatever paper
 * AirPrint hands the popup. The fix is to ask the backend for a real PDF
 * whose embedded page size matches the chosen sticker (2"x2", 2"x2.5", …),
 * then open that PDF in a new tab so AirPrint honors its baked-in page
 * size.
 *
 * What this test locks in
 * -----------------------
 *   1. `STICKER_SIZE_INCHES` covers every supported sticker size with the
 *      exact physical inch dimensions the UI advertises (no off-by-0.25
 *      etc.).
 *   2. `getStickerSizeInches` returns the right entry for each known size
 *      and falls back to "2x2.5" for an unknown size (matches the route's
 *      default sticker size — so an unknown UI size doesn't print as a
 *      tiny image).
 *   3. `pngBufferToSizedPdfBuffer` produces a real PDF whose embedded
 *      page size *exactly* matches the requested sticker, in PDF points
 *      (1in = 72pt). This is the root-cause assertion: AirPrint reads the
 *      PDF page size, so if this number is wrong the tiny-on-letter bug
 *      comes back.
 *   4. The output starts with a `%PDF-` magic header (so iOS treats it as
 *      a PDF, not octet-stream).
 *   5. Every supported sticker size round-trips through the helper at the
 *      right page size (regression matrix — the size matrix in the task's
 *      "Done looks like" section).
 *   6. The QuickStickerModal client still wires the mobile path to
 *      `format: "pdf"`. If someone "simplifies" it back into a popup with
 *      `@page size` CSS the test fails.
 *   7. The route forwards `application/pdf` for `format=pdf` requests.
 */

import * as fs from "fs";
import * as path from "path";
import {
  PDF_POINTS_PER_INCH,
  STICKER_SIZE_INCHES,
  getStickerSizeInches,
  pngBufferToSizedPdfBuffer,
} from "../lib/sticker-pdf";
import { PDFDocument } from "pdf-lib";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #219 regression checks");

// ---------------------------------------------------------------------------
// 1. STICKER_SIZE_INCHES covers the exact UI matrix at the right sizes.
// ---------------------------------------------------------------------------
const EXPECTED_SIZES: Array<[string, number, number]> = [
  ["1.5x2.25", 1.5, 2.25],
  ["2x2", 2.0, 2.0],
  ["2x2.5", 2.0, 2.5],
  ["2x3", 2.0, 3.0],
  ["2x3.5", 2.0, 3.5],
];

for (const [size, w, h] of EXPECTED_SIZES) {
  const entry = STICKER_SIZE_INCHES[size];
  ok(
    `STICKER_SIZE_INCHES has entry for "${size}"`,
    !!entry,
  );
  ok(
    `STICKER_SIZE_INCHES["${size}"] width == ${w}`,
    entry?.width === w,
    `got ${entry?.width}`,
  );
  ok(
    `STICKER_SIZE_INCHES["${size}"] height == ${h}`,
    entry?.height === h,
    `got ${entry?.height}`,
  );
}

ok(
  "STICKER_SIZE_INCHES has exactly the 5 supported sticker sizes",
  Object.keys(STICKER_SIZE_INCHES).length === EXPECTED_SIZES.length,
  `got keys: ${Object.keys(STICKER_SIZE_INCHES).join(",")}`,
);

// ---------------------------------------------------------------------------
// 2. getStickerSizeInches: known sizes pass through, unknown falls back to
//    the default "2x2.5" (matches the API route's default sticker size).
// ---------------------------------------------------------------------------
for (const [size, w, h] of EXPECTED_SIZES) {
  const got = getStickerSizeInches(size);
  ok(
    `getStickerSizeInches("${size}") matches the inch matrix`,
    got.width === w && got.height === h,
    `got ${JSON.stringify(got)}`,
  );
}

const fallback = getStickerSizeInches("4x4-not-a-real-size");
ok(
  "getStickerSizeInches(unknown) falls back to 2x2.5",
  fallback.width === 2.0 && fallback.height === 2.5,
  `got ${JSON.stringify(fallback)}`,
);

// ---------------------------------------------------------------------------
// 3 + 4. pngBufferToSizedPdfBuffer produces a PDF whose page size matches
//    the request in points, and starts with a `%PDF-` header.
// ---------------------------------------------------------------------------

// Smallest legitimate PNG: a 1x1 transparent pixel. This is enough to
// exercise the embed-PNG + addPage code path; we don't care about the
// pixels for this regression — only the page geometry of the wrapping PDF.
const TINY_TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function pageSizeFor(size: string): Promise<{ widthPt: number; heightPt: number }> {
  const inches = getStickerSizeInches(size);
  const pdfBytes = await pngBufferToSizedPdfBuffer(
    TINY_TRANSPARENT_PNG,
    inches.width,
    inches.height,
  );
  ok(
    `[${size}] pngBufferToSizedPdfBuffer returns a non-empty Buffer`,
    Buffer.isBuffer(pdfBytes) && pdfBytes.length > 0,
  );
  ok(
    `[${size}] PDF starts with %PDF- magic header`,
    pdfBytes.subarray(0, 5).toString("ascii") === "%PDF-",
    `got ${pdfBytes.subarray(0, 8).toString("ascii")}`,
  );
  const reopened = await PDFDocument.load(pdfBytes);
  ok(`[${size}] reopened PDF has exactly 1 page`, reopened.getPageCount() === 1);
  const [page] = reopened.getPages();
  const { width, height } = page.getSize();
  return { widthPt: width, heightPt: height };
}

async function runMatrix() {
  // 5. Full size matrix — every supported sticker size round-trips at the
  //    correct point dimensions. This is the assertion that AirPrint will
  //    print at the right physical size on iOS.
  for (const [size, widthIn, heightIn] of EXPECTED_SIZES) {
    const { widthPt, heightPt } = await pageSizeFor(size);
    const expectedW = widthIn * PDF_POINTS_PER_INCH;
    const expectedH = heightIn * PDF_POINTS_PER_INCH;
    // pdf-lib stores numbers exactly here; allow a tiny epsilon for safety.
    ok(
      `[${size}] PDF page width == ${expectedW}pt (= ${widthIn}in)`,
      Math.abs(widthPt - expectedW) < 0.001,
      `got ${widthPt}pt`,
    );
    ok(
      `[${size}] PDF page height == ${expectedH}pt (= ${heightIn}in)`,
      Math.abs(heightPt - expectedH) < 0.001,
      `got ${heightPt}pt`,
    );
    // Letter is 612x792 pt. If we ever accidentally regress to letter the
    // bug is back — assert explicitly so the failure is obvious.
    ok(
      `[${size}] PDF page is NOT letter-sized (would re-trigger the bug)`,
      !(Math.abs(widthPt - 612) < 0.001 && Math.abs(heightPt - 792) < 0.001),
      `got ${widthPt}x${heightPt}pt`,
    );
  }
}

// Sanity: PDF_POINTS_PER_INCH is the PDF spec value, not arbitrary.
ok("PDF_POINTS_PER_INCH === 72", PDF_POINTS_PER_INCH === 72);

// ---------------------------------------------------------------------------
// 6. QuickStickerModal still wires the mobile branch to format=pdf and
//    keeps the "do not regress to @page CSS" guard comment.
// ---------------------------------------------------------------------------
const modalSrc = fs.readFileSync(
  path.join(__dirname, "..", "components", "stickers", "QuickStickerModal.tsx"),
  "utf8",
);

ok(
  "QuickStickerModal contains a mobile-detection helper",
  /isMobileBrowser\s*\(/.test(modalSrc),
);
ok(
  "QuickStickerModal sends `format: \"pdf\"` on the mobile path",
  /format:\s*useMobilePdfPath\s*\?\s*"pdf"\s*:\s*"png"/.test(modalSrc),
);
ok(
  "QuickStickerModal opens the destination tab BEFORE awaiting the fetch (iOS gesture preservation)",
  // Within `handlePrint`, the `window.open(...)` call for the mobile path
  // must appear before the `await fetch("/api/sticker/generate")` call so
  // iOS Safari doesn't lose the user-gesture context.
  (() => {
    const handlePrintIdx = modalSrc.indexOf("function handlePrint");
    if (handlePrintIdx < 0) return false;
    const after = modalSrc.slice(handlePrintIdx);
    const openIdx = after.indexOf("mobilePrintWindow = window.open");
    const awaitFetchIdx = after.indexOf('await fetch("/api/sticker/generate"');
    return openIdx > -1 && awaitFetchIdx > -1 && openIdx < awaitFetchIdx;
  })(),
);
ok(
  "QuickStickerModal carries the 'do not simplify back to @page' guard comment",
  /Do NOT.*simplify.*@page/i.test(modalSrc),
);
ok(
  "QuickStickerModal handles popup-blocker fallback to PDF on desktop",
  /format:\s*"pdf"/.test(modalSrc) && /allow popups/.test(modalSrc),
);

// ---------------------------------------------------------------------------
// 7. The route forwards application/pdf when format=pdf is requested.
// ---------------------------------------------------------------------------
const routeSrc = fs.readFileSync(
  path.join(__dirname, "..", "app", "api", "sticker", "generate", "route.ts"),
  "utf8",
);
ok(
  "Sticker generate route accepts a `format` field on the request",
  /format\?:\s*"png"\s*\|\s*"pdf"/.test(routeSrc),
);
ok(
  "Sticker generate route returns application/pdf for format=pdf",
  /body\.format\s*===\s*"pdf"[\s\S]*Content-Type"\s*:\s*"application\/pdf"/.test(routeSrc),
);
ok(
  "Sticker generate route imports the sticker-pdf helper",
  /from\s+"@\/lib\/sticker-pdf"/.test(routeSrc),
);

runMatrix().then(() => {
  if (failed === 0) {
    console.log("\nAll Task #219 regression checks passed.");
    process.exit(0);
  } else {
    console.error(`\n${failed} Task #219 regression check(s) failed.`);
    process.exit(1);
  }
}).catch((err) => {
  console.error("Task #219 smoke crashed:", err);
  process.exit(1);
});
