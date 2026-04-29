/**
 * Regression smoke test for Task #204.
 *
 * Run: `npx tsx tests/plan-build-task-204.smoke.ts`
 *
 * Task #198 left `LIFETIME_FLUID_SERVICE_KEYS` unchanged. Task #204
 * extends the set to cover three more fluids that real-world OEM
 * schedules treat as lifetime on at least one platform:
 *
 *   - `dct`            — Dual-clutch transmission fluid (DSG, S-tronic,
 *                        PDK, PowerShift, …)
 *   - `awd_coupling`   — Haldex / on-demand AWD coupling fluid
 *                        (VW/Audi quattro on transverse, Volvo AWD,
 *                        Land Rover ATC, Subaru/Mazda i-Activ)
 *   - `hybrid_coolant` — Hybrid / EV inverter / HV-battery coolant
 *
 * Coverage:
 *   1. The new keys are present in `LIFETIME_FLUID_SERVICE_KEYS`.
 *   2. `toKeyFromName` maps representative OEM phrasings to the right
 *      key (DSG → dct, Haldex → awd_coupling, Inverter coolant →
 *      hybrid_coolant), without disturbing the existing trans_auto /
 *      transfer_case / coolant mappings.
 *   3. `isLifetimeFluidItem` flips ON for each new key when the OEM
 *      omits intervals (or marks the row as "fill for life").
 *   4. **No false positives**: `isLifetimeFluidItem` stays OFF for each
 *      new key when the OEM publishes a real, finite mileage interval.
 *      This is the regression-vs-VIN-sample assertion called out in the
 *      task ("a representative VIN sample confirms no false positives
 *      on schedules that DO list a real interval"). We can't dial out
 *      to DataOne from a smoke test, so we exercise the pure helper
 *      with the same shape the route hands it.
 *   5. `triage()` end-to-end: a no-interval Replace row on each new key
 *      surfaces as `recommendedDefault=true` at LIFETIME_FLUID_DEFAULT_MILES.
 *      A Replace row WITH a real interval keeps that interval and is
 *      NOT flagged as recommendedDefault.
 *   6. `isInspectOnlyFluidItem` recognises an Inspect row on the new
 *      keys (so the Task #198 inspect-only chip applies to them too).
 *   7. `SERVICE_KEY_DISPLAY_NAMES` has a human-readable label for every
 *      new key (so the UI never falls back to "Maintenance Item").
 */

import {
  triage,
  type OEMItem,
  type TriagedItem,
} from "../lib/plan-build/triage";
import {
  LIFETIME_FLUID_DEFAULT_MILES,
  LIFETIME_FLUID_SERVICE_KEYS,
  SERVICE_KEY_DISPLAY_NAMES,
  isInspectOnlyFluidItem,
  isLifetimeFluidItem,
  toKeyFromName,
} from "../lib/service-keys";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #204 regression checks");

// ---------------------------------------------------------------------------
// 1. Set membership.
// ---------------------------------------------------------------------------
const NEW_KEYS = ["dct", "awd_coupling", "hybrid_coolant"] as const;
for (const k of NEW_KEYS) {
  ok(
    `LIFETIME_FLUID_SERVICE_KEYS contains '${k}'`,
    LIFETIME_FLUID_SERVICE_KEYS.has(k),
  );
  ok(
    `SERVICE_KEY_DISPLAY_NAMES has a label for '${k}'`,
    typeof SERVICE_KEY_DISPLAY_NAMES[k] === "string" &&
      SERVICE_KEY_DISPLAY_NAMES[k].length > 0,
  );
}

// Sanity: the originals still in the set.
ok(
  "Pre-existing keys are still in LIFETIME_FLUID_SERVICE_KEYS",
  ["trans_auto", "trans_manual", "transfer_case", "front_differential",
    "rear_differential", "coolant", "brake_fluid", "power_steering"].every(
      (k) => LIFETIME_FLUID_SERVICE_KEYS.has(k),
    ),
);

// ---------------------------------------------------------------------------
// 2. `toKeyFromName` — name → key mapping for the new fluids.
// ---------------------------------------------------------------------------
const NAME_KEY_CASES: Array<[string, string]> = [
  // DCT family
  ["Replace DCT fluid", "dct"],
  ["Replace dual-clutch transmission fluid", "dct"],
  ["Replace DSG fluid", "dct"],
  ["Inspect DSG service", "dct"],
  ["Replace S-tronic fluid", "dct"],
  ["Replace PDK fluid", "dct"],
  ["Replace PowerShift fluid", "dct"],
  // Haldex / AWD coupling
  ["Replace Haldex fluid", "awd_coupling"],
  ["Replace Haldex oil", "awd_coupling"],
  ["Replace Haldex filter", "awd_coupling"],
  ["Replace AWD coupling fluid", "awd_coupling"],
  ["Replace rear coupling fluid", "awd_coupling"],
  // Hybrid / inverter coolant
  ["Replace inverter coolant", "hybrid_coolant"],
  ["Replace HV battery coolant", "hybrid_coolant"],
  ["Replace hybrid system coolant", "hybrid_coolant"],
  ["Replace power electronics coolant", "hybrid_coolant"],
];
for (const [name, expected] of NAME_KEY_CASES) {
  const got = toKeyFromName(name);
  ok(
    `toKeyFromName(${JSON.stringify(name)}) === '${expected}'`,
    got === expected,
    `got ${JSON.stringify(got)}`,
  );
}

// Negative-direction sanity: existing mappings are untouched by the new keys.
const UNCHANGED_CASES: Array<[string, string]> = [
  ["Replace automatic transmission fluid", "trans_auto"],
  ["Replace CVT fluid", "trans_auto"],
  ["Replace engine coolant", "coolant"],
  ["Replace transfer case fluid", "transfer_case"],
  ["Replace brake fluid", "brake_fluid"],
];
for (const [name, expected] of UNCHANGED_CASES) {
  const got = toKeyFromName(name);
  ok(
    `(unchanged) toKeyFromName(${JSON.stringify(name)}) === '${expected}'`,
    got === expected,
    `got ${JSON.stringify(got)}`,
  );
}

// ---------------------------------------------------------------------------
// 3. `isLifetimeFluidItem` — fires ON for each new key when there is a
//    lifetime signal (no intervals OR explicit lifetime text).
// ---------------------------------------------------------------------------
for (const k of NEW_KEYS) {
  ok(
    `isLifetimeFluidItem(${k}, no intervals) === true`,
    isLifetimeFluidItem({
      serviceKey: k,
      name: "Replace fluid",
      notes: null,
      miles: null,
      months: null,
      intervals: [],
    }) === true,
  );
  ok(
    `isLifetimeFluidItem(${k}, fill-for-life note) === true`,
    isLifetimeFluidItem({
      serviceKey: k,
      name: "Replace fluid",
      notes: "Fill for life - no service required",
      miles: null,
      months: null,
      intervals: [],
    }) === true,
  );
  ok(
    `isLifetimeFluidItem(${k}, lifetime interval row) === true`,
    isLifetimeFluidItem({
      serviceKey: k,
      name: "Replace fluid",
      notes: null,
      miles: null,
      months: null,
      intervals: [{ units: "lifetime", value: 0 }],
    }) === true,
  );
}

// ---------------------------------------------------------------------------
// 4. `isLifetimeFluidItem` — stays OFF for each new key when the OEM
//    publishes a real, finite mileage interval. This is the
//    no-false-positives assertion (proxy for the VIN-sample regression).
// ---------------------------------------------------------------------------
for (const k of NEW_KEYS) {
  ok(
    `isLifetimeFluidItem(${k}, real 60k mi interval) === false`,
    isLifetimeFluidItem({
      serviceKey: k,
      name: "Replace fluid",
      notes: null,
      miles: 60_000,
      months: null,
      intervals: [{ units: "Miles", value: 60_000 }],
    }) === false,
  );
  ok(
    `isLifetimeFluidItem(${k}, real 36-month interval) === false`,
    isLifetimeFluidItem({
      serviceKey: k,
      name: "Replace fluid",
      notes: null,
      miles: null,
      months: 36,
      intervals: [{ units: "Months", value: 36 }],
    }) === false,
  );
  ok(
    `isLifetimeFluidItem(${k}, real 100k mi interval, no notes) === false`,
    isLifetimeFluidItem({
      serviceKey: k,
      name: "Replace fluid",
      notes: "Inspect for leaks every service",
      miles: 100_000,
      months: null,
      intervals: [{ units: "Miles", value: 100_000 }],
    }) === false,
  );
}

// ---------------------------------------------------------------------------
// 5. End-to-end through `triage()`: a no-interval Replace row surfaces
//    as recommendedDefault at LIFETIME_FLUID_DEFAULT_MILES; a Replace
//    row WITH a real interval keeps that interval and is NOT flagged.
// ---------------------------------------------------------------------------
const baseTriageOpts = {
  carfaxRecords: [],
  currentMiles: 80_000,
  today: new Date("2026-04-29T00:00:00Z"),
  dviFindings: [],
  vehicleYear: 2019,
  vehicleTransType: "automatic",
};

function findItem(
  triaged: ReturnType<typeof triage>,
  predicate: (t: TriagedItem) => boolean,
): TriagedItem | undefined {
  for (const bucket of [triaged.overdue, triaged.dueSoon, triaged.upcoming]) {
    const m = bucket.find(predicate);
    if (m) return m;
  }
  return undefined;
}

const SCENARIOS: Array<{
  label: string;
  serviceKey: (typeof NEW_KEYS)[number];
  lifetimeName: string;
  lifetimeNotes: string | null;
  lifetimeMaintenanceId: number;
  realName: string;
  realMiles: number;
  realMaintenanceId: number;
}> = [
  {
    label: "DSG (DCT)",
    serviceKey: "dct",
    lifetimeName: "Replace DSG fluid",
    lifetimeNotes: "Fill for life - no service required",
    lifetimeMaintenanceId: 70_001,
    realName: "Replace DSG fluid",
    realMiles: 40_000,
    realMaintenanceId: 71_001,
  },
  {
    label: "Haldex (AWD coupling)",
    serviceKey: "awd_coupling",
    lifetimeName: "Replace Haldex fluid",
    lifetimeNotes: null,
    lifetimeMaintenanceId: 70_002,
    realName: "Replace Haldex fluid",
    realMiles: 30_000,
    realMaintenanceId: 71_002,
  },
  {
    label: "Hybrid coolant",
    serviceKey: "hybrid_coolant",
    lifetimeName: "Replace inverter coolant",
    lifetimeNotes: null,
    lifetimeMaintenanceId: 70_003,
    realName: "Replace inverter coolant",
    realMiles: 100_000,
    realMaintenanceId: 71_003,
  },
];

for (const sc of SCENARIOS) {
  // 5a. Lifetime-style row → recommendedDefault=true at 120k mi.
  {
    const oemItems: OEMItem[] = [
      {
        maintenance_id: sc.lifetimeMaintenanceId,
        name: sc.lifetimeName,
        category: "Drivetrain",
        miles: null,
        months: null,
        intervals: sc.lifetimeNotes ? [] : [{ units: "lifetime", value: 0 }],
        notes: sc.lifetimeNotes,
      },
    ];
    const triaged = triage({ ...baseTriageOpts, oemItems });
    const row = findItem(triaged, (t) => t.serviceKey === sc.serviceKey);
    ok(
      `${sc.label}: lifetime row surfaces in triaged buckets`,
      !!row,
    );
    ok(
      `${sc.label}: lifetime row recommendedDefault=true`,
      row?.recommendedDefault === true,
    );
    ok(
      `${sc.label}: lifetime row interval == LIFETIME_FLUID_DEFAULT_MILES`,
      row?.intervalMiles === LIFETIME_FLUID_DEFAULT_MILES,
    );
    ok(
      `${sc.label}: lifetime row is NOT flagged inspectOnly (mutually exclusive)`,
      !row?.inspectOnly,
    );
  }

  // 5b. Real-interval row → recommendedDefault=false, OEM cadence kept.
  {
    const oemItems: OEMItem[] = [
      {
        maintenance_id: sc.realMaintenanceId,
        name: sc.realName,
        category: "Drivetrain",
        miles: sc.realMiles,
        months: null,
        intervals: [{ units: "Miles", value: sc.realMiles }],
        notes: null,
      },
    ];
    const triaged = triage({ ...baseTriageOpts, oemItems });
    const row = findItem(triaged, (t) => t.serviceKey === sc.serviceKey);
    ok(
      `${sc.label}: real-interval row surfaces in triaged buckets`,
      !!row,
    );
    ok(
      `${sc.label}: real-interval row keeps the OEM cadence (${sc.realMiles} mi)`,
      row?.intervalMiles === sc.realMiles,
    );
    ok(
      `${sc.label}: real-interval row is NOT flagged recommendedDefault`,
      !row?.recommendedDefault,
    );
  }
}

// ---------------------------------------------------------------------------
// 6. Inspect-only chip works for the new fluid keys too.
// ---------------------------------------------------------------------------
for (const k of NEW_KEYS) {
  ok(
    `isInspectOnlyFluidItem({${k}, inspect}) === true`,
    isInspectOnlyFluidItem({ serviceKey: k, action: "inspect" }) === true,
  );
  ok(
    `isInspectOnlyFluidItem({${k}, replace}) === false`,
    isInspectOnlyFluidItem({ serviceKey: k, action: "replace" }) === false,
  );
}

if (failed === 0) {
  console.log("\nAll Task #204 regression checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} Task #204 regression check(s) failed.`);
  process.exit(1);
}
