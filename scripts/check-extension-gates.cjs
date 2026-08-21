#!/usr/bin/env node
/**
 * Lint check (two passes):
 *
 * Pass 1 — Feature-gate coverage
 * ──────────────────────────────
 * Every shop-scoped extension route must call the central feature gate
 * (or be explicitly opted out).
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
 * Pass 2 — Policy-matrix coverage
 * ─────────────────────────────────
 * Every HTTP method exported from every extension route file must appear
 * in lib/extension-route-policy.ts.  Non-public, non-preflight routes
 * must also call validateExtensionToken directly or indirectly via
 * guardExtensionShopRequest / requireMigAdmin.
 *
 * Usage:
 *   node scripts/check-extension-gates.cjs
 *
 * Exit codes:
 *   0 — all routes are either gated/classified or explicitly exempt
 *   1 — one or more routes are missing a gate or policy entry
 *   2 — script error
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EXT_DIR = path.join(ROOT, "app", "api", "extension");
const POLICY_FILE = path.join(ROOT, "lib", "extension-route-policy.ts");
const EXTENSION_BACKEND_FILES = [
  "app/api/tekmetric/apply-canned-job/route.ts",
  "app/api/protractor/apply-canned-job/route.ts",
  "app/api/estimate-assist/audit/route.ts",
  "app/api/estimate-assist/job-builder/route.ts",
  "app/api/vehicle/common-failures/route.ts",
].map((file) => path.join(ROOT, file));

const GUARD_IMPORT = "@/lib/extension-route-guard";
const SHOP_LOOKUP_IMPORT = "@/lib/extension-shop-lookup";
// gate-exempt comment must appear in the FIRST 5 lines of the file (top-of-file)
const EXEMPT_HEADER_LINES = 5;
const EXEMPT_MARKER = /^\/\/\s*gate-exempt:\s*\S/;
// Must actually call one of the gate functions, not just import.
const GUARD_CALL = /\b(guardExtensionShopRequest|checkShopFeatureGate)\s*\(/;

// Auth-coverage markers — any of these in the file counts as "authenticated"
const AUTH_CALL = /\b(validateExtensionToken|guardExtensionShopRequest|requireMigAdmin|checkShopFeatureGate)\s*\(/;

// HTTP method export pattern (covers both `export async function GET` and
// `export const GET = ...` forms)
const HTTP_METHOD_RE = /\bexport\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS)\b/g;

const ALL_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

// ─── helpers ──────────────────────────────────────────────────────────────

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
  const callsAuth = AUTH_CALL.test(src);
  const headerLines = src.split("\n").slice(0, EXEMPT_HEADER_LINES);
  const exempt = headerLines.some((line) => EXEMPT_MARKER.test(line));

  // Collect all exported HTTP methods
  const exportedMethods = [];
  let m;
  HTTP_METHOD_RE.lastIndex = 0;
  while ((m = HTTP_METHOD_RE.exec(src)) !== null) {
    if (ALL_HTTP_METHODS.has(m[1]) && !exportedMethods.includes(m[1])) {
      exportedMethods.push(m[1]);
    }
  }

  return { src, importsShopLookup, importsGuard, callsGuard, callsAuth, exempt, exportedMethods };
}

/**
 * Convert a file path under app/api/extension/** to its canonical URL
 * pathname (Next.js dynamic segments stay as-is, e.g. [id]).
 *
 * e.g. ".../app/api/extension/tekmetric-migration/runs/[id]/dump/route.ts"
 *      → "/api/extension/tekmetric-migration/runs/[id]/dump"
 */
function fileToPathname(file) {
  const rel = path
    .relative(path.join(ROOT, "app"), file)
    .replace(/\\/g, "/") // Windows
    .replace(/\/route\.ts$/, "");
  return "/" + rel;
}

// ─── policy-map reader ────────────────────────────────────────────────────

/**
 * Parse the POLICY_MAP from lib/extension-route-policy.ts using simple
 * string scanning (no TS compilation needed).  Returns a Set of
 * "<pathname>|<METHOD>" strings that are registered.
 */
function loadPolicyKeys() {
  if (!fs.existsSync(POLICY_FILE)) {
    throw new Error(`Policy file not found: ${POLICY_FILE}`);
  }
  const src = fs.readFileSync(POLICY_FILE, "utf8");
  const keys = new Set();
  // Match lines like:  "/api/extension/foo/bar|POST": ["write"],
  const lineRe = /^\s*["']([^"']+\|(?:GET|POST|PUT|PATCH|DELETE|OPTIONS))["']\s*:/gm;
  let m;
  while ((m = lineRe.exec(src)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

/**
 * Parse the POLICY_MAP tiers for a given key.
 * Returns an array of tier strings or null when not found.
 */
function loadPolicyTiers(src) {
  // Returns a Map of key → tiers[]
  const map = new Map();
  const re = /["']([^"']+\|(?:GET|POST|PUT|PATCH|DELETE|OPTIONS))["']\s*:\s*\[([^\]]*)\]/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const key = m[1];
    const tiersRaw = m[2];
    const tiers = tiersRaw.match(/["']([^"']+)["']/g)?.map((t) => t.replace(/["']/g, "")) || [];
    map.set(key, tiers);
  }
  return map;
}

// ─── main ─────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(EXT_DIR)) {
    console.error(`[check-extension-gates] no extension dir at ${EXT_DIR}`);
    process.exit(2);
  }

  let policyKeys;
  let policyTiers;
  try {
    const policySrc = fs.readFileSync(POLICY_FILE, "utf8");
    policyKeys = loadPolicyKeys();
    policyTiers = loadPolicyTiers(policySrc);
  } catch (err) {
    console.error("[check-extension-gates] error reading policy file:", err.message);
    process.exit(2);
  }

  const files = [...walk(EXT_DIR), ...EXTENSION_BACKEND_FILES];
  const violations = [];

  // ── Pass 1: feature-gate coverage ─────────────────────────────────────
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const { importsShopLookup, importsGuard, callsGuard, exempt } = classify(file);

    if (exempt) continue;

    // A route that resolves a shop must (a) import the guard module AND
    // (b) actually call one of its functions. Importing alone is not enough.
    if (importsShopLookup) {
      if (!importsGuard) {
        violations.push(
          `[gate] ${rel}\n    imports ${SHOP_LOOKUP_IMPORT} but does NOT import ${GUARD_IMPORT}.\n` +
            "    Either route through guardExtensionShopRequest / checkShopFeatureGate,\n" +
            `    or add a top-of-file marker comment (within first ${EXEMPT_HEADER_LINES} lines):  // gate-exempt: <reason>`,
        );
      } else if (!callsGuard) {
        violations.push(
          `[gate] ${rel}\n    imports ${GUARD_IMPORT} but never calls guardExtensionShopRequest()\n` +
            "    or checkShopFeatureGate(). The import is dead — wire up an actual gate call.",
        );
      }
    }
  }

  // ── Pass 2: policy-matrix coverage ────────────────────────────────────
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const { exportedMethods, callsAuth, exempt } = classify(file);
    const pathname = fileToPathname(file);

    for (const method of exportedMethods) {
      const policyKey = `${pathname}|${method}`;
      if (!policyKeys.has(policyKey)) {
        violations.push(
          `[policy] ${rel} — exports ${method} but "${policyKey}" is not in lib/extension-route-policy.ts.\n` +
            "    Add an entry to POLICY_MAP with the appropriate tier(s).",
        );
        continue;
      }

      // Non-public, non-preflight routes must authenticate
      const tiers = policyTiers.get(policyKey) || [];
      const isPublicOrPreflight =
        tiers.includes("public") || tiers.includes("preflight");

      if (!isPublicOrPreflight && !callsAuth) {
        violations.push(
          `[auth] ${rel} — ${method} is classified as [${tiers.join(", ")}] but the file\n` +
            "    never calls validateExtensionToken / guardExtensionShopRequest / requireMigAdmin.\n" +
            "    Wire up authentication or add a gate-exempt: comment with a reason.",
        );
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `[check-extension-gates] OK — ${files.length} route file(s) checked` +
        ` (${policyKeys.size} policy entries verified).`,
    );
    process.exit(0);
  }

  console.error(
    `[check-extension-gates] FAIL — ${violations.length} violation(s):\n`,
  );
  for (const v of violations) console.error("  • " + v + "\n");
  process.exit(1);
}

main();
