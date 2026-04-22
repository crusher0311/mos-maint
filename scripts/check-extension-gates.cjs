#!/usr/bin/env node
/**
 * Lint check: every shop-scoped extension route must call the central feature
 * gate (or be explicitly opted out).
 *
 * What counts as a "shop-scoped" extension route:
 *   - Lives under app/api/extension/**\/route.ts
 *   - Imports `findShopBySmsId` from "@/lib/extension-shop-lookup"
 *     (i.e. it resolves a shop from extension input)
 *
 * What "gated" means: the file imports something from
 * "@/lib/extension-route-guard" (either `guardExtensionShopRequest` or
 * `checkShopFeatureGate`) AND actually calls it.
 *
 * Opt-out: a route may add a top-of-file marker comment, e.g.
 *
 *     // gate-exempt: this route only reports the user's own entitlements
 *
 * The marker must include a free-text reason after the colon.
 *
 * Usage:
 *   node scripts/check-extension-gates.cjs
 *
 * Exit codes:
 *   0 — all routes are either gated or explicitly exempt
 *   1 — one or more routes are missing a gate
 *   2 — script error
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EXT_DIR = path.join(ROOT, "app", "api", "extension");

const GUARD_IMPORT = "@/lib/extension-route-guard";
const SHOP_LOOKUP_IMPORT = "@/lib/extension-shop-lookup";
// gate-exempt comment must appear in the FIRST 5 lines of the file (top-of-file)
const EXEMPT_HEADER_LINES = 5;
const EXEMPT_MARKER = /^\/\/\s*gate-exempt:\s*\S/;
// Must actually call one of the gate functions, not just import.
const GUARD_CALL = /\b(guardExtensionShopRequest|checkShopFeatureGate)\s*\(/;

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && entry.name === "route.ts") files.push(full);
  }
  return files;
}

function classify(file) {
  const src = fs.readFileSync(file, "utf8");
  const importsShopLookup = src.includes(SHOP_LOOKUP_IMPORT);
  const importsGuard = src.includes(GUARD_IMPORT);
  const callsGuard = GUARD_CALL.test(src);
  const headerLines = src.split("\n").slice(0, EXEMPT_HEADER_LINES);
  const exempt = headerLines.some((line) => EXEMPT_MARKER.test(line));
  return { src, importsShopLookup, importsGuard, callsGuard, exempt };
}

function main() {
  if (!fs.existsSync(EXT_DIR)) {
    console.error(`[check-extension-gates] no extension dir at ${EXT_DIR}`);
    process.exit(2);
  }

  const files = walk(EXT_DIR);
  const violations = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const { importsShopLookup, importsGuard, callsGuard, exempt } = classify(file);

    if (exempt) continue;

    // A route that resolves a shop must (a) import the guard module AND
    // (b) actually call one of its functions. Importing alone is not enough.
    if (importsShopLookup) {
      if (!importsGuard) {
        violations.push(
          `${rel}\n    imports ${SHOP_LOOKUP_IMPORT} but does NOT import ${GUARD_IMPORT}.\n` +
            "    Either route through guardExtensionShopRequest / checkShopFeatureGate,\n" +
            `    or add a top-of-file marker comment (within first ${EXEMPT_HEADER_LINES} lines):  // gate-exempt: <reason>`,
        );
      } else if (!callsGuard) {
        violations.push(
          `${rel}\n    imports ${GUARD_IMPORT} but never calls guardExtensionShopRequest()\n` +
            "    or checkShopFeatureGate(). The import is dead — wire up an actual gate call.",
        );
      }
    }
  }

  if (violations.length === 0) {
    console.log(`[check-extension-gates] OK — ${files.length} route file(s) checked.`);
    process.exit(0);
  }

  console.error(
    `[check-extension-gates] FAIL — ${violations.length} route(s) missing a feature gate:\n`,
  );
  for (const v of violations) console.error("  • " + v + "\n");
  process.exit(1);
}

main();
