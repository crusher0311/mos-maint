#!/usr/bin/env node
/**
 * Fails if UTF-8 mojibake byte sequences (double-encoded text like "â€™",
 * "âœ…", "âŒ", "Ã©") appear in user-facing source under app/, components/,
 * or lib/. These come from decoding UTF-8 as Latin-1 and would show up as
 * garbage characters in the UI.
 */
const fs = require("fs");
const path = require("path");

const ROOTS = ["app", "components", "lib"];
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".css", ".html", ".md"]);
// Tell-tale mojibake lead bytes: Â (U+00C2), Ã (U+00C3) followed by another
// non-ASCII char, â (U+00E2) + 0x80-0x9F-range punctuation pairs, ð (U+00F0) sequences.
const MOJIBAKE = /(?:\u00C3[\u0080-\u00BF\u0152\u0153\u2019\u201C\u201D\u2020\u2021\u02C6\u2030\u0160\u2039\u017D\u017E\u2018\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0178\u00A0-\u00FF])|(?:\u00E2[\u0080-\u00BF\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178\u20AC\u2564\u2551\u2550\u255D\u255A\u2557\u2554\u2588\u00A0-\u00FF])|(?:\u00F0\u0178)|(?:\u00C2[\u00A0-\u00BF])/;

let failures = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (EXTS.has(path.extname(entry.name))) checkFile(full);
  }
}

function checkFile(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!MOJIBAKE.test(text)) return;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (MOJIBAKE.test(line)) failures.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}

for (const root of ROOTS) {
  if (fs.existsSync(root)) walk(root);
}

if (failures.length) {
  console.error("Mojibake (double-encoded UTF-8) found in source files:");
  for (const f of failures) console.error("  " + f);
  console.error(
    "\nFix: replace the garbled sequence with the intended character (e.g. \u00E2\u20AC\u2122 -> \u2019, \u00E2\u0153\u2026 -> \u2705, \u00E2\u20AC\u00A6 -> \u2026)."
  );
  process.exit(1);
}
console.log("check-mojibake: OK (no mojibake sequences found)");
