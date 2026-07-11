/**
 * Smoke test for the index-friendly dashboard search helpers (task #758).
 *
 * Run: `npx tsx tests/dashboard-search.smoke.ts`
 *
 * Verifies that the Mongo search predicates are anchored (prefix) so they are
 * index-eligible, that user input is escaped, that VIN is upper-cased and
 * matched case-sensitively, and that the anchored regexes still match the same
 * values a prefix search should.
 */

import { escapeRegex, prefixRegex, vinPrefix } from "../lib/dashboard-search";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("Dashboard search helpers");

// 1. Regex metacharacters are escaped so input is treated literally.
ok(
  "escapeRegex neutralizes metacharacters",
  escapeRegex("a.b*c(d)") === "a\\.b\\*c\\(d\\)",
  escapeRegex("a.b*c(d)"),
);

// 2. prefixRegex is anchored (index-eligible) and case-insensitive by default.
const make = prefixRegex("toy");
ok("prefixRegex is anchored with ^", make.$regex.startsWith("^"), make.$regex);
ok("prefixRegex defaults to case-insensitive", make.$options === "i");

// 3. Anchored regex matches a prefix and rejects a non-prefix (mid-string).
const re = new RegExp(make.$regex, make.$options);
ok("prefix matches 'Toyota' (case-insensitive)", re.test("Toyota"));
ok("prefix does NOT match mid-string 'Detoy'", !re.test("Detoy"));

// 4. Escaped input can't inject regex behavior.
const dot = prefixRegex("a.c");
const dotRe = new RegExp(dot.$regex, dot.$options);
ok("'.' is literal, matches 'a.cme'", dotRe.test("a.cme"));
ok("'.' is literal, does NOT match 'abcme'", !dotRe.test("abcme"));

// 5. VIN is upper-cased, anchored, and case-sensitive (tight index bounds).
const vin = vinPrefix("1hgcm");
ok("vinPrefix upper-cases the term", vin.$regex === "^1HGCM", vin.$regex);
ok("vinPrefix has no case-insensitive flag", !("$options" in vin));
const vinRe = new RegExp(vin.$regex);
ok("VIN prefix matches uppercased VIN", vinRe.test("1HGCM82633A004352"));
ok("VIN prefix rejects lowercase (data is upper)", !vinRe.test("1hgcm82633a004352"));

console.log("");
if (failed > 0) {
  console.error(`FAILED: ${failed} assertion(s)`);
  process.exit(1);
}
console.log("All dashboard-search assertions passed.");
