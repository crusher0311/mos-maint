/**
 * Unit-level smoke test for the OEMItem mapper.
 *
 * Run: `npx tsx tests/plan-build-oem-mapper.smoke.ts`
 *
 * Tasks #163/#165 added higher-level integration smoke tests for the
 * triage path; this test pins the field-by-field behavior of the
 * `toOEMItem` mapper itself so a silent regression in the mapping (e.g.
 * dropping `maintenance_notes`, mishandling the `intervals` array, picking
 * the wrong fallback for `name` / `category`) trips this test instead of
 * slipping out to production.
 *
 * The mapper accepts two input shapes in production:
 *   1. Raw DataOne `MaintenanceItem` rows with `maintenance_*` fields.
 *   2. Already-flattened `{ name, category, miles, months, ... }` rows
 *      coming from caches or fixtures.
 * Both shapes are exercised here.
 */

import { toOEMItem } from "../lib/plan-build/oem-item";
import type { MaintenanceItem } from "../lib/integrations/dataone-local";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Plan-build OEMItem mapper smoke checks");

// 1. DataOne MaintenanceItem shape: every field flows through.
const dataOneRow: MaintenanceItem = {
  maintenance_id: 1234,
  maintenance_category: "Engine",
  maintenance_name: "Replace engine oil and filter",
  maintenance_notes: "Use 0W-20 synthetic only",
  intervals: [
    { interval_id: 11, interval_type: "Normal", value: 10000, units: "Miles", initial_value: 10000 },
    { interval_id: 12, interval_type: "Normal", value: 12, units: "Months", initial_value: 12 },
  ],
  miles: 10000,
  months: 12,
};

const mapped = toOEMItem(dataOneRow);
ok("maintenance_id passes through", mapped.maintenance_id === 1234);
ok("maintenance_name → name", mapped.name === "Replace engine oil and filter");
ok("maintenance_category → category", mapped.category === "Engine");
ok("miles passes through", mapped.miles === 10000);
ok("months passes through", mapped.months === 12);
ok(
  "maintenance_notes → notes",
  mapped.notes === "Use 0W-20 synthetic only",
  `notes=${JSON.stringify(mapped.notes)}`,
);
ok(
  "intervals are mapped to {units, value} pairs",
  Array.isArray(mapped.intervals) && mapped.intervals.length === 2,
  `intervals=${JSON.stringify(mapped.intervals)}`,
);
ok(
  "intervals[0].units is preserved",
  mapped.intervals?.[0]?.units === "Miles",
);
ok(
  "intervals[0].value is preserved",
  mapped.intervals?.[0]?.value === 10000,
);
ok(
  "intervals do NOT carry interval_id / interval_type (mapper trims to triage shape)",
  !("interval_id" in (mapped.intervals?.[0] ?? {})) &&
    !("interval_type" in (mapped.intervals?.[0] ?? {})),
);

// 2. Already-flattened shape: `name`/`category`/`notes` are taken directly
//    when the `maintenance_*` fields are absent.
const flattened = toOEMItem({
  maintenance_id: "misc-7",
  name: "Replace cabin air filter",
  category: "HVAC",
  notes: "Behind the glove box",
  miles: 30000,
  months: 24,
  intervals: [{ units: "Miles", value: 30000 }],
});
ok("flattened: name passes through directly", flattened.name === "Replace cabin air filter");
ok("flattened: category passes through directly", flattened.category === "HVAC");
ok("flattened: notes passes through directly", flattened.notes === "Behind the glove box");
ok("flattened: miles/months pass through", flattened.miles === 30000 && flattened.months === 24);
ok(
  "flattened: intervals are still normalized to {units, value}",
  flattened.intervals?.[0]?.units === "Miles" && flattened.intervals?.[0]?.value === 30000,
);

// 3. maintenance_* fields take precedence over flattened equivalents when
//    BOTH are present (ensures DataOne stays the source of truth on
//    overlapping inputs).
const both = toOEMItem({
  maintenance_id: 9,
  maintenance_name: "Replace ATF",
  maintenance_category: "Drivetrain",
  maintenance_notes: "Lifetime fluid",
  name: "DO NOT USE",
  category: "DO NOT USE",
  notes: "DO NOT USE",
  miles: null,
  months: null,
  intervals: [],
});
ok("maintenance_name wins over name", both.name === "Replace ATF");
ok("maintenance_category wins over category", both.category === "Drivetrain");
ok("maintenance_notes wins over notes", both.notes === "Lifetime fluid");

// 4. Defensive defaults: missing fields become null/[]; non-array intervals
//    do not crash and degrade to an empty array.
const empty = toOEMItem({});
ok("empty input: name is undefined (no source field)", empty.name === undefined);
ok("empty input: category is undefined", empty.category === undefined);
ok("empty input: miles defaults to null", empty.miles === null);
ok("empty input: months defaults to null", empty.months === null);
ok("empty input: notes defaults to null", empty.notes === null);
ok(
  "empty input: intervals defaults to []",
  Array.isArray(empty.intervals) && empty.intervals.length === 0,
);

const badIntervals = toOEMItem({
  maintenance_id: 99,
  maintenance_name: "Weird row",
  intervals: "not an array",
});
ok(
  "non-array intervals are coerced to [] (no crash)",
  Array.isArray(badIntervals.intervals) && badIntervals.intervals.length === 0,
);

// 5. Null / undefined interval entry fields don't propagate undefined —
//    the mapper normalizes them to null so downstream `lifetime` checks
//    don't NPE.
const sparseIntervals = toOEMItem({
  maintenance_id: 100,
  maintenance_name: "Sparse row",
  intervals: [{}, { units: "Lifetime" }, { value: 5000 }],
});
ok(
  "sparse intervals are normalized (units defaults to null)",
  sparseIntervals.intervals?.[0]?.units === null &&
    sparseIntervals.intervals?.[2]?.units === null,
);
ok(
  "sparse intervals are normalized (value defaults to null)",
  sparseIntervals.intervals?.[0]?.value === null &&
    sparseIntervals.intervals?.[1]?.value === null,
);
ok(
  "sparse intervals preserve provided fields",
  sparseIntervals.intervals?.[1]?.units === "Lifetime" &&
    sparseIntervals.intervals?.[2]?.value === 5000,
);

// 6. Null `maintenance_notes` from DataOne stays as null (not coerced to
//    "null" string or undefined).
const nullNotes = toOEMItem({
  maintenance_id: 5,
  maintenance_name: "Replace coolant",
  maintenance_notes: null,
});
ok("null maintenance_notes stays null", nullNotes.notes === null);

if (failed === 0) {
  console.log("\nAll OEMItem mapper smoke checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} OEMItem mapper smoke check(s) failed.`);
  process.exit(1);
}
