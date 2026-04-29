/**
 * Task #177: smoke tests for the engine-risk CSV pipeline.
 *
 * Run: `npx tsx tests/engine-risk-csv.smoke.ts`
 *
 * Pure-function coverage of:
 *   1. Round-trip: serialize → parse yields the same overrides.
 *   2. CSV escaping handles commas, quotes, and newlines.
 *   3. Validation flags missing label/reason, bad action, bad numbers,
 *      and bad _id hex.
 *   4. Diff classifies add / update / remove / unchanged correctly,
 *      surfacing only the field changes that actually differ.
 *   5. Updates can target an existing row by _id and unchanged rows
 *      stay as "unchanged".
 */

import {
  ENGINE_RISK_OVERRIDE_CSV_COLUMNS,
  InvalidOverrideCsvError,
  computeOverrideDiff,
  parseOverridesCsv,
  serializeOverridesToCsv,
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

console.log("Task #177 engine-risk CSV pipeline checks");

// --- 1. Round-trip ---
const ID_A = "507f1f77bcf86cd799439011";
const ID_B = "507f1f77bcf86cd799439012";

const sample: EngineRiskOverride[] = [
  {
    _id: ID_A,
    label: "Pentastar 3.6",
    reason: "Oil consumption",
    action: "flag",
    match: {
      make: "Ram",
      model: null,
      yearMin: 2011,
      yearMax: null,
      engineNamePattern: "Pentastar",
      engineSize: 3.6,
      induction: null,
      aspiration: null,
      cylindersMax: null,
    },
  },
  {
    _id: ID_B,
    label: "EcoBoost 2.7",
    reason: 'Specifies "5W-30, severe duty"',
    action: "clear",
    match: {
      make: "Ford",
      model: "F-150",
      yearMin: null,
      yearMax: null,
      engineNamePattern: "EcoBoost",
      engineSize: 2.7,
      induction: "Direct",
      aspiration: "Turbocharged",
      cylindersMax: 6,
    },
  },
];

const csv = serializeOverridesToCsv(sample);
const headerLine = csv.split("\n")[0];
ok(
  "header lists all canonical columns",
  headerLine === ENGINE_RISK_OVERRIDE_CSV_COLUMNS.join(","),
  headerLine,
);
ok("CSV ends with newline", csv.endsWith("\n"));
ok(
  "CSV escapes embedded commas/quotes",
  csv.includes('"Specifies ""5W-30, severe duty"""'),
);

const parsedRoundTrip = parseOverridesCsv(csv);
ok("round-trip preserves row count", parsedRoundTrip.length === sample.length);
ok(
  "round-trip preserves first row label",
  parsedRoundTrip[0].override?.label === "Pentastar 3.6",
);
ok(
  "round-trip preserves complex reason with quotes/commas",
  parsedRoundTrip[1].override?.reason === 'Specifies "5W-30, severe duty"',
);
ok(
  "round-trip preserves numeric fields",
  parsedRoundTrip[0].override?.match.yearMin === 2011 &&
    parsedRoundTrip[0].override?.match.engineSize === 3.6 &&
    parsedRoundTrip[1].override?.match.cylindersMax === 6,
);
ok(
  "round-trip preserves _id",
  parsedRoundTrip[0].override?._id === ID_A &&
    parsedRoundTrip[1].override?._id === ID_B,
);

// --- 2. Diff against current with no changes is all-unchanged ---
const diffNoOp = computeOverrideDiff(parsedRoundTrip, sample);
ok(
  "round-trip diff has zero changes",
  diffNoOp.summary.add === 0 &&
    diffNoOp.summary.update === 0 &&
    diffNoOp.summary.remove === 0 &&
    diffNoOp.summary.unchanged === sample.length,
);

// --- 3. Validation errors ---
const badCsv = [
  ENGINE_RISK_OVERRIDE_CSV_COLUMNS.join(","),
  // missing label and reason; bad action
  ",,wat,,,,,,,,,,",
  // bad number, bad id
  "notahexid,Lab,flag,Reason here,Toyota,,abc,,,,,,",
].join("\n");
const badParsed = parseOverridesCsv(badCsv);
ok("bad row count", badParsed.length === 2);
const errs0 = badParsed[0].errors.join("|");
ok(
  "row 1 reports missing label",
  badParsed[0].errors.some((e) => e.includes("label is required")),
  errs0,
);
ok(
  "row 1 reports missing reason",
  badParsed[0].errors.some((e) => e.includes("reason is required")),
  errs0,
);
ok(
  "row 1 reports bad action",
  badParsed[0].errors.some((e) => e.includes("action must be")),
  errs0,
);
const errs1 = badParsed[1].errors.join("|");
ok(
  "row 2 reports bad _id hex",
  badParsed[1].errors.some((e) => e.includes("_id must be")),
  errs1,
);
ok(
  "row 2 reports bad number",
  badParsed[1].errors.some((e) => e.includes("yearMin: not a number")),
  errs1,
);

const badDiff = computeOverrideDiff(badParsed, []);
ok(
  "diff surfaces error rows",
  badDiff.summary.errors === 2 && badDiff.summary.add === 0,
);

// --- 4. Add / update / remove ---
// Existing in DB: keep first, change second's reason; drop ID_B; add a brand new row.
const ID_C = "507f1f77bcf86cd799439013";
const dbCurrent: EngineRiskOverride[] = [
  sample[0],
  sample[1],
  {
    _id: ID_C,
    label: "Cleared row",
    reason: "no longer needed",
    action: "clear",
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
  },
];

const incomingCsvRows = [
  ENGINE_RISK_OVERRIDE_CSV_COLUMNS.join(","),
  // unchanged: same as sample[0]
  `${ID_A},Pentastar 3.6,flag,Oil consumption,Ram,,2011,,Pentastar,3.6,,,`,
  // updated: same _id as sample[1] but reason changed and aspiration cleared
  `${ID_B},EcoBoost 2.7,clear,Updated reason,Ford,F-150,,,EcoBoost,2.7,Direct,,6`,
  // new row, no _id
  `,New family,flag,New rule,Subaru,,,,,,,,4`,
].join("\n");
const incomingParsed = parseOverridesCsv(incomingCsvRows);
const diff = computeOverrideDiff(incomingParsed, dbCurrent);

ok(
  "diff summary tallies",
  diff.summary.add === 1 &&
    diff.summary.update === 1 &&
    diff.summary.unchanged === 1 &&
    diff.summary.remove === 1 &&
    diff.summary.errors === 0,
  JSON.stringify(diff.summary),
);

const updateEntry = diff.entries.find((e) => e.status === "update");
ok("update entry present", !!updateEntry);
ok(
  "update entry tracks reason change",
  !!updateEntry?.changes?.some(
    (c) => c.field === "reason" && c.from === "Specifies \"5W-30, severe duty\"" && c.to === "Updated reason",
  ),
  JSON.stringify(updateEntry?.changes),
);
ok(
  "update entry tracks aspiration cleared",
  !!updateEntry?.changes?.some(
    (c) => c.field === "match.aspiration" && c.from === "Turbocharged" && c.to === null,
  ),
  JSON.stringify(updateEntry?.changes),
);
ok(
  "update entry does not list unchanged fields",
  !updateEntry?.changes?.some((c) => c.field === "action") &&
    !updateEntry?.changes?.some((c) => c.field === "label"),
  JSON.stringify(updateEntry?.changes),
);

const removeEntry = diff.entries.find((e) => e.status === "remove");
ok("remove targets dropped row", removeEntry?._id === ID_C);

const addEntry = diff.entries.find((e) => e.status === "add");
ok("add entry has new label", addEntry?.label === "New family");
ok(
  "add entry has parsed match fields",
  addEntry?.next?.match.make === "Subaru" && addEntry?.next?.match.cylindersMax === 4,
);

// --- 4b. Header-only CSV → diff should remove every existing override ---
const headerOnly = ENGINE_RISK_OVERRIDE_CSV_COLUMNS.join(",") + "\n";
const headerOnlyParsed = parseOverridesCsv(headerOnly);
ok("header-only CSV parses to zero rows", headerOnlyParsed.length === 0);
const wipeDiff = computeOverrideDiff(headerOnlyParsed, dbCurrent);
ok(
  "header-only diff removes every current override",
  wipeDiff.summary.remove === dbCurrent.length &&
    wipeDiff.summary.add === 0 &&
    wipeDiff.summary.update === 0 &&
    wipeDiff.summary.unchanged === 0,
  JSON.stringify(wipeDiff.summary),
);

// --- 4c. Duplicate _id in a single CSV is flagged as an error ---
const dupCsv = [
  ENGINE_RISK_OVERRIDE_CSV_COLUMNS.join(","),
  `${ID_A},Pentastar 3.6,flag,Original,Ram,,2011,,Pentastar,3.6,,,`,
  `${ID_A},Pentastar 3.6,flag,Conflicting reason,Ram,,2011,,Pentastar,3.6,,,`,
].join("\n");
const dupParsed = parseOverridesCsv(dupCsv);
const dupDiff = computeOverrideDiff(dupParsed, [sample[0]]);
ok(
  "duplicate _id in CSV produces error entries",
  dupDiff.summary.errors === 2 &&
    dupDiff.summary.update === 0 &&
    dupDiff.summary.unchanged === 0,
  JSON.stringify(dupDiff.summary),
);
ok(
  "duplicate _id error mentions the offending id",
  dupDiff.entries
    .filter((e) => e.status === "error")
    .every((e) => e.errors?.some((m) => m.includes(ID_A))),
);

// --- 4d. Bad headers fail fast instead of pretending to "remove all" ---
let headerErr: unknown;
try {
  parseOverridesCsv("foo,bar,baz\n1,2,3\n");
} catch (e) {
  headerErr = e;
}
ok(
  "missing required headers throws InvalidOverrideCsvError",
  headerErr instanceof InvalidOverrideCsvError,
);
ok(
  "header error mentions the missing required columns",
  headerErr instanceof Error &&
    headerErr.message.includes("label") &&
    headerErr.message.includes("action") &&
    headerErr.message.includes("reason"),
);

// --- 5. _id provided but not in DB → still treated as add ---
const orphanCsv = [
  ENGINE_RISK_OVERRIDE_CSV_COLUMNS.join(","),
  `aaaaaaaaaaaaaaaaaaaaaaaa,Orphan,flag,Reason,,,,,,,,,`,
].join("\n");
const orphanParsed = parseOverridesCsv(orphanCsv);
const orphanDiff = computeOverrideDiff(orphanParsed, []);
ok(
  "orphan _id treated as add (not error)",
  orphanDiff.summary.add === 1 && orphanDiff.summary.errors === 0,
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Task #177 CSV checks passed");
