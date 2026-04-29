/**
 * Task #188: regression smoke for the destructive-CSV-import guardrail.
 *
 * Run: `npx tsx tests/plan-build-task-188.smoke.ts`
 *
 * Pure-function coverage of `evaluateDestructiveImport` plus a thin
 * integration check against `computeOverrideDiff` so the end-to-end
 * thresholds stay in sync with the diff shape the route consumes:
 *
 *   1. Empty current dataset is never destructive.
 *   2. Removing fewer rows than the floor stays non-destructive even
 *      when the percentage is high (tiny dataset corner case).
 *   3. Removing >floor and >=fraction trips the destructive flag and
 *      surfaces a human-readable reason.
 *   4. Just under the threshold (either dimension) stays non-destructive.
 *   5. Custom thresholds (env-var path) override the defaults.
 *   6. Header-only CSV against a large dataset is destructive.
 *   7. The default constants stay at 25% / 5 rows so an env-var change
 *      is the only way to relax the guardrail.
 */

import {
  DEFAULT_DESTRUCTIVE_REMOVE_FLOOR,
  DEFAULT_DESTRUCTIVE_REMOVE_FRACTION,
  ENGINE_RISK_OVERRIDE_CSV_COLUMNS,
  computeOverrideDiff,
  evaluateDestructiveImport,
  parseOverridesCsv,
  type OverrideDiff,
} from "../lib/engine-risk-csv";
import type { EngineRiskOverride } from "../lib/engine-risk";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #188 — destructive CSV-import guardrail");

// --- 0. Defaults are the documented values ---
ok(
  "default fraction is 25%",
  DEFAULT_DESTRUCTIVE_REMOVE_FRACTION === 0.25,
  String(DEFAULT_DESTRUCTIVE_REMOVE_FRACTION),
);
ok(
  "default floor is 5 rows",
  DEFAULT_DESTRUCTIVE_REMOVE_FLOOR === 5,
  String(DEFAULT_DESTRUCTIVE_REMOVE_FLOOR),
);

function fakeDiff(remove: number): OverrideDiff {
  return {
    entries: [],
    summary: {
      total: 0,
      add: 0,
      update: 0,
      remove,
      unchanged: 0,
      errors: 0,
    },
  };
}

// --- 1. Empty current dataset ---
const emptyCurrent = evaluateDestructiveImport(fakeDiff(0), 0);
ok(
  "empty current dataset is not destructive",
  !emptyCurrent.destructive && emptyCurrent.fractionRemoved === 0,
  JSON.stringify(emptyCurrent),
);

// --- 2. Tiny dataset: removing 100% but only 3 rows stays safe ---
const tinyHighPct = evaluateDestructiveImport(fakeDiff(3), 3);
ok(
  "removing all 3 rows of a 3-row set is below the floor and not destructive",
  !tinyHighPct.destructive,
  JSON.stringify(tinyHighPct),
);

// --- 3. Big destructive import trips the flag ---
const bigDestructive = evaluateDestructiveImport(fakeDiff(8), 20);
ok(
  "removing 8 of 20 (40%) is destructive",
  bigDestructive.destructive,
  JSON.stringify(bigDestructive),
);
ok(
  "destructive evaluation surfaces a reason mentioning the counts",
  typeof bigDestructive.reason === "string" &&
    bigDestructive.reason.includes("8 of 20") &&
    bigDestructive.reason.includes("40%") &&
    bigDestructive.reason.includes("25%"),
  bigDestructive.reason,
);

// --- 4a. Just at the floor (removed === floor) is not destructive ---
const atFloor = evaluateDestructiveImport(fakeDiff(5), 20);
ok(
  "removing exactly the floor (5 of 20) is not destructive",
  !atFloor.destructive,
  JSON.stringify(atFloor),
);

// --- 4b. Just under the fraction is not destructive ---
const underFraction = evaluateDestructiveImport(fakeDiff(6), 100);
ok(
  "removing 6 of 100 (6%) is not destructive",
  !underFraction.destructive,
  JSON.stringify(underFraction),
);

// --- 4c. Exactly at the fraction trips the flag (>= semantics) ---
const atFraction = evaluateDestructiveImport(fakeDiff(25), 100);
ok(
  "removing 25 of 100 (exactly 25%) is destructive",
  atFraction.destructive,
  JSON.stringify(atFraction),
);

// --- 5. Custom thresholds (env-var path) ---
const customLooser = evaluateDestructiveImport(fakeDiff(8), 20, {
  fractionThreshold: 0.5,
  floor: 5,
});
ok(
  "raising fraction threshold to 50% spares the 40% removal",
  !customLooser.destructive,
  JSON.stringify(customLooser),
);

const customStricter = evaluateDestructiveImport(fakeDiff(2), 10, {
  fractionThreshold: 0.1,
  floor: 1,
});
ok(
  "tightening floor=1 + fraction=10% catches a 2-of-10 removal",
  customStricter.destructive,
  JSON.stringify(customStricter),
);

const invalidOpts = evaluateDestructiveImport(fakeDiff(8), 20, {
  fractionThreshold: -1 as unknown as number,
  floor: Number.NaN,
});
ok(
  "invalid env values fall back to defaults",
  invalidOpts.fractionThreshold === DEFAULT_DESTRUCTIVE_REMOVE_FRACTION &&
    invalidOpts.floor === DEFAULT_DESTRUCTIVE_REMOVE_FLOOR &&
    invalidOpts.destructive,
  JSON.stringify(invalidOpts),
);

// --- 6. End-to-end: header-only CSV against a 20-row dataset ---
function makeOverride(i: number): EngineRiskOverride {
  return {
    _id: `aaaaaaaaaaaaaaaaaaaa${String(i).padStart(4, "0")}`,
    label: `row-${i}`,
    reason: `reason ${i}`,
    action: "flag",
    match: {
      make: null,
      model: null,
      yearMin: null,
      yearMax: null,
      engineNamePattern: null,
      engineSize: null,
      induction: null,
      aspiration: null,
      cylindersMax: null,
    },
  };
}
const dbCurrent: EngineRiskOverride[] = Array.from({ length: 20 }, (_, i) =>
  makeOverride(i),
);
const headerOnly = ENGINE_RISK_OVERRIDE_CSV_COLUMNS.join(",") + "\n";
const headerOnlyParsed = parseOverridesCsv(headerOnly);
const wipeDiff = computeOverrideDiff(headerOnlyParsed, dbCurrent);
const wipeEval = evaluateDestructiveImport(wipeDiff, dbCurrent.length);
ok(
  "header-only CSV against a 20-row DB is destructive (wipes all 20)",
  wipeEval.destructive &&
    wipeEval.removed === 20 &&
    wipeEval.currentTotal === 20,
  JSON.stringify(wipeEval),
);

// --- 7. End-to-end: small partial drop stays non-destructive ---
const partialCsv = [
  ENGINE_RISK_OVERRIDE_CSV_COLUMNS.join(","),
  ...dbCurrent
    .slice(0, 17) // drop the last 3 of 20 → 15%, also under floor
    .map(
      (o) =>
        `${o._id},${o.label},${o.action},${o.reason},,,,,,,,,`,
    ),
].join("\n");
const partialParsed = parseOverridesCsv(partialCsv);
const partialDiff = computeOverrideDiff(partialParsed, dbCurrent);
const partialEval = evaluateDestructiveImport(partialDiff, dbCurrent.length);
ok(
  "dropping 3 of 20 rows is not destructive",
  partialDiff.summary.remove === 3 && !partialEval.destructive,
  JSON.stringify({ summary: partialDiff.summary, eval: partialEval }),
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Task #188 destructive-import checks passed");
