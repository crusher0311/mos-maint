#!/usr/bin/env node
/**
 * Lint check: the Tekmetric Shop Migration wizard was extracted into the
 * standalone `mos-migrate-extension/` Chrome extension in Task #292. The
 * whole point of pulling it out was to eliminate the risk that a future
 * regression accidentally re-introduces the Migrate tab to the customer-
 * facing `mos-tools-extension/`. This script grep-asserts that none of
 * the migrate-only tokens have crept back into the four files that
 * actually render and wire the side panel:
 *
 *   - mos-tools-extension/sidepanel.html
 *   - mos-tools-extension/sidepanel.js
 *   - mos-tools-extension/sidepanel.css
 *   - mos-tools-extension/background.js
 *
 * Forbidden tokens (Task #295)
 * ----------------------------
 *   - tab-migrate            (the tab panel id)
 *   - tab-btn-migrate        (the tab button id)
 *   - migrate-wizard         (wizard container class/id)
 *   - migrate-step           (wizard step class/id)
 *   - mig<X>...              (any helper identifier whose name begins with
 *                             "mig" — covers both short-form camelCase
 *                             helpers (migInit, migNext, migStep) and
 *                             the longer "migrate*" / "migration*"
 *                             spellings (migrateWizard, migrateNext,
 *                             migrationStep). Matches identifiers of
 *                             the form /\bmig[A-Za-z0-9_]*\b/.)
 *   - tekmetric-migration    (the API path the wizard called)
 *   - data-super-admin-only  (the gate attribute that hid the tab)
 *   - isSuperAdmin           (the main extension no longer needs this
 *                             flag — only the standalone migrate
 *                             extension does)
 *
 * Comments are stripped before scanning (JS // and /* *\/, CSS /* *\/, and
 * HTML <!-- -->) so docstrings that *describe* the legacy migrate tab —
 * including this script's own banner and the sanitizer comment in
 * sidepanel.js that warns about legacy `"migrate"` defaultExtensionTab
 * values — don't trip the check. Only live code / markup / styles count.
 *
 * Usage:
 *   node mos-tools-extension/scripts/check-no-migrate-tab.cjs
 *
 * Exit codes:
 *   0 — no migrate tokens present in the main extension
 *   1 — one or more forbidden tokens found
 *   2 — script error (missing files, etc.)
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const EXT_ROOT = path.resolve(__dirname, "..");

const TARGETS = [
  { file: path.join(EXT_ROOT, "sidepanel.html"), kind: "html" },
  { file: path.join(EXT_ROOT, "sidepanel.js"), kind: "js" },
  { file: path.join(EXT_ROOT, "sidepanel.css"), kind: "css" },
  { file: path.join(EXT_ROOT, "background.js"), kind: "js" },
];

// Each rule has a regex applied to the comment-stripped source plus a
// human-readable name shown in the failure message.
const RULES = [
  { name: "tab-migrate", re: /\btab-migrate\b/g },
  { name: "tab-btn-migrate", re: /\btab-btn-migrate\b/g },
  { name: "migrate-wizard", re: /\bmigrate-wizard\b/g },
  { name: "migrate-step", re: /\bmigrate-step\b/g },
  { name: "tekmetric-migration", re: /\btekmetric-migration\b/g },
  { name: "data-super-admin-only", re: /\bdata-super-admin-only\b/g },
  { name: "isSuperAdmin", re: /\bisSuperAdmin\b/g },
  // mig* helper identifier — matches BOTH short camelCase helpers
  // (migInit, migNext, migStep) and the longer "migrate*" / "migration*"
  // spellings (migrateWizard, migrateNext, migrationStep). After comment
  // stripping the four target files have zero legitimate identifiers
  // beginning with "mig", so this broad match is safe and catches the
  // full helper-name space the Migrate wizard used.
  { name: "mig* helper identifier", re: /\bmig[A-Za-z0-9_]*\b/g },
];

// ------------------------------------------------------------------
// Comment stripping (one impl per file kind)
// ------------------------------------------------------------------

function stripJsComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      // preserve newline so line numbers stay accurate
      while (i < n && src[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        out += src[i];
        if (src[i] === "\\" && i + 1 < n) {
          out += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripCssComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src[i] === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

function stripHtmlComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src.startsWith("<!--", i)) {
      i += 4;
      while (i < n && !src.startsWith("-->", i)) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 3;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

function stripComments(src, kind) {
  if (kind === "js") return stripJsComments(src);
  if (kind === "css") return stripCssComments(src);
  if (kind === "html") return stripHtmlComments(src);
  return src;
}

function lineNumberOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

function checkFile(target) {
  const violations = [];
  if (!fs.existsSync(target.file)) {
    return [
      {
        file: path.relative(REPO_ROOT, target.file),
        line: 0,
        rule: "missing-file",
        msg:
          `expected file not found — Task #295 guard cannot run. Update ` +
          `the TARGETS list in this script if the file was renamed.`,
      },
    ];
  }
  const raw = fs.readFileSync(target.file, "utf8");
  const src = stripComments(raw, target.kind);
  const rel = path.relative(REPO_ROOT, target.file);
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(src)) !== null) {
      violations.push({
        file: rel,
        line: lineNumberOf(src, m.index),
        rule: rule.name,
        msg:
          `forbidden token "${m[0]}" matches Migrate-tab pattern ` +
          `"${rule.name}". The Tekmetric Shop Migration wizard was ` +
          `extracted into the standalone mos-migrate-extension/ in ` +
          `Task #292 and must NOT come back to the customer-facing ` +
          `mos-tools-extension/ (Task #295). If you need wizard logic, ` +
          `change it in mos-migrate-extension/ instead.`,
      });
    }
  }
  return violations;
}

// ------------------------------------------------------------------
// Self-test: lock in matcher behavior so a future edit to RULES can't
// silently weaken the guard. Runs every invocation (it's microseconds)
// so CI can never use a broken matcher.
// ------------------------------------------------------------------

function runSelfTest() {
  // each case = { src, kind, mustMatch: [rule names...], mustNotMatch: [...] }
  const cases = [
    // mig* helper variants — all must trip the helper rule
    { src: "function migInit() {}", kind: "js",
      mustMatch: ["mig* helper identifier"] },
    { src: "function migrateWizard() {}", kind: "js",
      mustMatch: ["mig* helper identifier"] },
    { src: "const x = migrateNext();", kind: "js",
      mustMatch: ["mig* helper identifier"] },
    { src: "function migrationStep() {}", kind: "js",
      mustMatch: ["mig* helper identifier"] },
    // explicit token rules
    { src: "<div id=\"tab-migrate\"></div>", kind: "html",
      mustMatch: ["tab-migrate"] },
    { src: "<button id=\"tab-btn-migrate\"></button>", kind: "html",
      mustMatch: ["tab-btn-migrate"] },
    { src: ".migrate-wizard { display: none; }", kind: "css",
      mustMatch: ["migrate-wizard"] },
    { src: ".migrate-step {}", kind: "css",
      mustMatch: ["migrate-step"] },
    { src: "fetch('/api/tekmetric-migration/start')", kind: "js",
      mustMatch: ["tekmetric-migration"] },
    { src: "<div data-super-admin-only></div>", kind: "html",
      mustMatch: ["data-super-admin-only"] },
    { src: "if (user.isSuperAdmin) {}", kind: "js",
      mustMatch: ["isSuperAdmin"] },
    // negatives — must NOT trip
    { src: "// migrateWizard is gone — see Task #292", kind: "js",
      mustNotMatch: ["mig* helper identifier"] },
    { src: "/* tab-migrate removed */", kind: "js",
      mustNotMatch: ["tab-migrate", "mig* helper identifier"] },
    { src: "<!-- migrate-wizard lived here -->", kind: "html",
      mustNotMatch: ["migrate-wizard", "mig* helper identifier"] },
    { src: "/* .migrate-step gone */", kind: "css",
      mustNotMatch: ["migrate-step", "mig* helper identifier"] },
    { src: "const amigo = 1; const enigma = 2;", kind: "js",
      mustNotMatch: ["mig* helper identifier"] },
  ];

  const failures = [];
  for (const c of cases) {
    const stripped = stripComments(c.src, c.kind);
    const hits = new Set();
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      if (rule.re.test(stripped)) hits.add(rule.name);
    }
    for (const want of c.mustMatch || []) {
      if (!hits.has(want)) {
        failures.push(
          `expected rule "${want}" to fire on ${JSON.stringify(c.src)} ` +
            `(${c.kind}) but it did not`,
        );
      }
    }
    for (const nope of c.mustNotMatch || []) {
      if (hits.has(nope)) {
        failures.push(
          `rule "${nope}" should NOT fire on ${JSON.stringify(c.src)} ` +
            `(${c.kind}) but it did`,
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error(
      `[check-no-migrate-tab] SELF-TEST FAILED — the matcher rules in ` +
        `this script are broken. Fix RULES before relying on this guard.\n`,
    );
    for (const f of failures) console.error(`  • ${f}`);
    process.exit(2);
  }
}

function main() {
  runSelfTest();

  const violations = [];
  for (const target of TARGETS) {
    violations.push(...checkFile(target));
  }

  if (violations.length === 0) {
    console.log(
      `[check-no-migrate-tab] OK — ${TARGETS.length} file(s) clean of ` +
        `Migrate-tab tokens.`,
    );
    process.exit(0);
  }

  // any "missing-file" violation is a script-config error, not a code
  // regression — surface it with exit 2 so it's distinguishable in CI.
  const hadMissing = violations.some((v) => v.rule === "missing-file");

  console.error(
    `[check-no-migrate-tab] FAIL — ${violations.length} violation(s):\n`,
  );
  for (const v of violations) {
    console.error(`  • ${v.file}:${v.line}  [${v.rule}]  ${v.msg}\n`);
  }
  console.error(
    `See Task #292 (extraction) and Task #295 (this guard). The Migrate ` +
      `wizard now lives in mos-migrate-extension/.`,
  );
  process.exit(hadMissing ? 2 : 1);
}

main();
