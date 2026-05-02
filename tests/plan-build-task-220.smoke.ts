/**
 * Regression smoke test for Task #220 — extend the iOS sticker print fix
 * to the dashboard's reprint, key tag, and second sticker print flows.
 *
 * Run: `npx tsx tests/plan-build-task-220.smoke.ts`
 *
 * Background
 * ----------
 * Task #219 fixed the Quick Sticker iOS print path so a 2x2 sticker prints
 * as a real 2"x2" sheet instead of a tiny image on letter. The same root
 * cause — iOS Safari/AirPrint ignoring CSS `@page { size }` — also affected
 * the dashboard's:
 *   1. sticker reprint flow (handleQuickPrintStickerWithValues)
 *   2. key tag flow (handlePrintKeytag)
 *   3. quick-print sticker flow (handleQuickPrintSticker)
 *
 * The fix reuses the Task #219 building blocks: the sticker generate route's
 * `format=pdf` branch, an analogous branch on the key tag generate route,
 * and a shared `lib/print-mobile.ts` helper that handles UA-based mobile
 * detection and synchronous-window-open + blob-URL navigation.
 *
 * What this test locks in
 * -----------------------
 *   1. The shared print-mobile helper still exports the three building
 *      blocks every print site reuses.
 *   2. The key tag generate route accepts `format: "pdf"`, returns
 *      application/pdf, and sizes the PDF using the resolved paper size
 *      (widthIn/heightIn) — not a hard-coded letter page.
 *   3. The PDF page size produced by `pngBufferToSizedPdfBuffer` for every
 *      key tag paper preset matches its real physical inch dimensions in
 *      PDF points, so AirPrint will print at true size on iOS.
 *   4. All three dashboard print sites:
 *        - call `isMobilePrintBrowser()`
 *        - synchronously open the placeholder window BEFORE awaiting the
 *          generate fetch (iOS gesture preservation)
 *        - send `format: 'pdf'` on the mobile path
 *        - navigate the placeholder via `navigateWindowToPdfBlob`
 *      and the Quick Sticker modal still passes Task #219.
 */

import * as fs from "fs";
import * as path from "path";
import { PDFDocument } from "pdf-lib";
import {
  PDF_POINTS_PER_INCH,
  pngBufferToSizedPdfBuffer,
} from "../lib/sticker-pdf";
import { PAPER_SIZE_PRESETS, resolvePaperSize } from "../lib/keytag-paper-sizes";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #220 regression checks");

// ---------------------------------------------------------------------------
// 1. Shared print-mobile helper exists and exports the three building blocks
//    every dashboard print site reuses.
// ---------------------------------------------------------------------------
const helperPath = path.join(__dirname, "..", "lib", "print-mobile.ts");
ok("lib/print-mobile.ts exists", fs.existsSync(helperPath));
const helperSrc = fs.readFileSync(helperPath, "utf8");
ok(
  "exports isMobilePrintBrowser",
  /export\s+function\s+isMobilePrintBrowser/.test(helperSrc),
);
ok(
  "exports openMobilePlaceholderWindow",
  /export\s+function\s+openMobilePlaceholderWindow/.test(helperSrc),
);
ok(
  "exports navigateWindowToPdfBlob",
  /export\s+function\s+navigateWindowToPdfBlob/.test(helperSrc),
);
ok(
  "isMobilePrintBrowser detects iPadOS-as-Macintosh via maxTouchPoints",
  /Macintosh[\s\S]*maxTouchPoints/.test(helperSrc),
);

// ---------------------------------------------------------------------------
// 2. Key tag generate route accepts format=pdf and wires through paper size.
// ---------------------------------------------------------------------------
const keytagRoutePath = path.join(
  __dirname,
  "..",
  "app",
  "api",
  "keytag",
  "generate",
  "route.ts",
);
const keytagRouteSrc = fs.readFileSync(keytagRoutePath, "utf8");
ok(
  "Key tag route accepts a `format` field on the request",
  /format\?:\s*"png"\s*\|\s*"pdf"/.test(keytagRouteSrc),
);
ok(
  "Key tag route returns application/pdf for format=pdf",
  /body\.format\s*===\s*"pdf"[\s\S]*Content-Type[\s\S]*application\/pdf/.test(
    keytagRouteSrc,
  ),
);
ok(
  "Key tag route imports the sticker-pdf helper",
  /from\s+"@\/lib\/sticker-pdf"/.test(keytagRouteSrc),
);
ok(
  "Key tag route sizes the PDF from the resolved paper size (widthIn/heightIn)",
  /pngBufferToSizedPdfBuffer\([\s\S]*paper\.widthIn[\s\S]*paper\.heightIn/.test(
    keytagRouteSrc,
  ),
);

// ---------------------------------------------------------------------------
// 3. PDF page size matches every key tag paper preset in real inches.
//    This is the root-cause assertion: AirPrint reads the PDF page size, so
//    if this number is wrong the tiny-on-letter bug comes back for key tags.
// ---------------------------------------------------------------------------

// Smallest legitimate PNG: a 1x1 transparent pixel. Enough to exercise the
// embed-PNG + addPage code path; we only care about wrapping page geometry.
const TINY_TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function runPaperMatrix() {
  for (const preset of PAPER_SIZE_PRESETS) {
    const paper = resolvePaperSize({ presetId: preset.id });
    const pdfBytes = await pngBufferToSizedPdfBuffer(
      TINY_TRANSPARENT_PNG,
      paper.widthIn,
      paper.heightIn,
    );
    ok(
      `[${preset.id}] PDF starts with %PDF- magic header`,
      pdfBytes.subarray(0, 5).toString("ascii") === "%PDF-",
    );
    const reopened = await PDFDocument.load(pdfBytes);
    ok(`[${preset.id}] reopened PDF has exactly 1 page`, reopened.getPageCount() === 1);
    const [page] = reopened.getPages();
    const { width, height } = page.getSize();
    const expectedW = paper.widthIn * PDF_POINTS_PER_INCH;
    const expectedH = paper.heightIn * PDF_POINTS_PER_INCH;
    ok(
      `[${preset.id}] PDF page width == ${expectedW}pt (= ${paper.widthIn}in)`,
      Math.abs(width - expectedW) < 0.001,
      `got ${width}pt`,
    );
    ok(
      `[${preset.id}] PDF page height == ${expectedH}pt (= ${paper.heightIn}in)`,
      Math.abs(height - expectedH) < 0.001,
      `got ${height}pt`,
    );
    // Letter is 612x792pt. If we ever accidentally regress to letter the
    // bug is back — assert explicitly so the failure is obvious.
    ok(
      `[${preset.id}] PDF page is NOT letter-sized (would re-trigger the bug)`,
      !(Math.abs(width - 612) < 0.001 && Math.abs(height - 792) < 0.001),
      `got ${width}x${height}pt`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. DashboardClient wires all three print sites to the mobile PDF path,
//    opens the placeholder window before any await, sends format=pdf, and
//    navigates via navigateWindowToPdfBlob.
// ---------------------------------------------------------------------------
const dashSrc = fs.readFileSync(
  path.join(__dirname, "..", "app", "dashboard", "DashboardClient.tsx"),
  "utf8",
);

ok(
  "DashboardClient imports the shared print-mobile helper",
  /from\s+"@\/lib\/print-mobile"/.test(dashSrc),
);

const HANDLER_NAMES = [
  "handleQuickPrintStickerWithValues",
  "handlePrintKeytag",
  "handleQuickPrintSticker",
];

function handlerBody(src: string, name: string): string {
  const idx = src.indexOf(`const ${name} =`);
  if (idx < 0) return "";
  // Take a generous window — each handler is well under 12k chars
  // (handleQuickPrintSticker is the longest at ~10k).
  return src.slice(idx, idx + 12000);
}

for (const name of HANDLER_NAMES) {
  const body = handlerBody(dashSrc, name);
  ok(`${name}: handler exists`, body.length > 0);
  ok(
    `${name}: calls isMobilePrintBrowser()`,
    /isMobilePrintBrowser\s*\(\)/.test(body),
  );
  ok(
    `${name}: opens placeholder window before any await`,
    (() => {
      const openIdx = body.indexOf("openMobilePlaceholderWindow");
      const awaitIdx = body.indexOf("await ");
      return openIdx > -1 && awaitIdx > -1 && openIdx < awaitIdx;
    })(),
  );
  ok(
    `${name}: sends format: 'pdf' on the mobile path`,
    /format:\s*useMobilePdfPath\s*\?\s*['"]pdf['"]/.test(body),
  );
  ok(
    `${name}: navigates the placeholder via navigateWindowToPdfBlob`,
    /navigateWindowToPdfBlob\s*\(/.test(body),
  );
  ok(
    `${name}: closes the placeholder window if the request blows up`,
    /mobilePrintWindow[\s\S]*close/.test(body),
  );
}

// ---------------------------------------------------------------------------
// Designer audit (per task #220): components/sticker-designer/* and
// components/keytag-designer/* must NOT contain their own browser print
// path. They are pure visual editors; printing is initiated from the
// dashboard handlers (already covered above) or from QuickStickerModal.
// If anyone adds a `window.print()` or `@page` rule to a designer they
// MUST route it through `lib/print-mobile.ts` so iOS prints at real size
// — fail loudly here so that future change can't slip in without using
// the shared helper.
// ---------------------------------------------------------------------------
const DESIGNER_DIRS = [
  path.join(__dirname, "..", "components", "sticker-designer"),
  path.join(__dirname, "..", "components", "keytag-designer"),
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(p);
  }
  return out;
}

for (const dir of DESIGNER_DIRS) {
  for (const file of walk(dir)) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(path.join(__dirname, ".."), file);
    // Reject any direct browser print API or @page CSS — if a designer
    // ever needs to print, it must go through lib/print-mobile.ts.
    const hasWindowPrint = /\bwindow\.print\s*\(/.test(src);
    const hasContentWindowPrint = /\.contentWindow\?\.print\s*\(/.test(src);
    const hasAtPage = /@page\b/.test(src);
    ok(
      `${rel}: no direct window.print() (must use lib/print-mobile)`,
      !hasWindowPrint,
    );
    ok(
      `${rel}: no contentWindow.print() (must use lib/print-mobile)`,
      !hasContentWindowPrint,
    );
    ok(
      `${rel}: no @page CSS (would re-trigger the iOS tiny-image bug)`,
      !hasAtPage,
    );
  }
}

// ---------------------------------------------------------------------------
// Quick Sticker modal still passes Task #219's mobile-path checks.
// ---------------------------------------------------------------------------
const modalSrc = fs.readFileSync(
  path.join(__dirname, "..", "components", "stickers", "QuickStickerModal.tsx"),
  "utf8",
);
ok(
  "QuickStickerModal still wires `format: \"pdf\"` on the mobile path",
  /format:\s*useMobilePdfPath\s*\?\s*"pdf"\s*:\s*"png"/.test(modalSrc),
);

runPaperMatrix().then(() => {
  if (failed === 0) {
    console.log("\nAll Task #220 regression checks passed.");
    process.exit(0);
  } else {
    console.error(`\n${failed} Task #220 regression check(s) failed.`);
    process.exit(1);
  }
}).catch((err) => {
  console.error("Task #220 smoke crashed:", err);
  process.exit(1);
});
