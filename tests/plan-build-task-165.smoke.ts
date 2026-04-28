/**
 * Integration smoke test for Task #165.
 *
 * Run: `npx tsx tests/plan-build-task-165.smoke.ts`
 *
 * Task #163 added a unit-level smoke test that covers the helper
 * functions (`parseServiceAction`, `isLifetimeFluidItem`, the schema
 * version bump). That guards the helpers but does NOT prove the full
 * plan-build pipeline still surfaces the right items on the demo VIN.
 * If the OEMItem mapper, the triage call, or the cache shape silently
 * drops `notes` / `recommendedDefault` / `intervalMiles` again, the
 * unit-level test would still pass while the customer-facing plan goes
 * back to its old broken behavior.
 *
 * This test seeds a fake DataOne `MaintenanceItem[]` for the demo VIN
 * `1C6RR6FG7KS516181` (2019 Ram 1500), runs the same OEMItem mapper
 * `app/api/plan-build/route.ts` uses, calls the real `triage()` and
 * `convertToCache()` helpers, and then asserts that:
 *
 *   1. An "Inspect …" row keeps the verb in its title (not relabeled to
 *      the canonical "Automatic Transmission Fluid").
 *   2. A lifetime-fluid OEM row produces a TriagedItem with
 *      `recommendedDefault === true` and `intervalMiles === 120000`
 *      (the LIFETIME_FLUID_DEFAULT_MILES constant).
 *   3. `maintenance_notes` from DataOne flows through to the cache
 *      shape so the UI can render it.
 *
 * The DataOne mirror is faked deliberately so this test is deterministic
 * and does not require the Postgres mirror to be available in CI.
 */

import {
  triage,
  convertToCache,
  toOEMItem,
  type OEMItem,
} from "../lib/plan-build/triage";
import { LIFETIME_FLUID_DEFAULT_MILES } from "../lib/service-keys";
import type { MaintenanceItem } from "../lib/integrations/dataone-local";

const DEMO_VIN = "1C6RR6FG7KS516181";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log(`Task #165 plan-build integration smoke for VIN ${DEMO_VIN}`);

/**
 * Faked DataOne `MaintenanceItem[]` for VIN 1C6RR6FG7KS516181 (2019 Ram
 * 1500 with the 8-spd auto). Mirrors the rows we see in the real
 * `dataone_def_maintenance` / `dataone_def_maintenance_interval` mirror:
 *   - an inspect-only ATF row with no fixed interval (lifetime fluid)
 *   - a "Replace automatic transmission fluid" row with maintenance_notes
 *     ("If equipped with dipstick…") and a `lifetime` interval row
 *   - a routine "Replace engine oil and filter" row at 10k mi / 12 mo
 *   - a brake-fluid row marked "Fill for life" in the notes
 *
 * The fake intentionally exercises three regression hot spots in the
 * triage path: the verb-preservation logic, the lifetime-fluid default
 * synthesis, and the maintenance_notes pass-through.
 */
const fakeDataOneItems: MaintenanceItem[] = [
  {
    maintenance_id: 9001,
    maintenance_category: "Drivetrain",
    maintenance_name: "Inspect automatic transmission fluid",
    maintenance_notes: "If equipped with dipstick",
    intervals: [],
    miles: null,
    months: null,
  },
  {
    maintenance_id: 9002,
    maintenance_category: "Drivetrain",
    maintenance_name: "Replace automatic transmission fluid",
    maintenance_notes: "Replace if necessary. Lifetime fluid - no scheduled service.",
    intervals: [
      { interval_id: 1, interval_type: "Normal", value: 0, units: "Lifetime", initial_value: 0 },
    ],
    miles: null,
    months: null,
  },
  {
    maintenance_id: 9003,
    maintenance_category: "Engine",
    maintenance_name: "Replace engine oil and filter",
    maintenance_notes: null,
    intervals: [
      { interval_id: 2, interval_type: "Normal", value: 10000, units: "Miles", initial_value: 10000 },
      { interval_id: 3, interval_type: "Normal", value: 12, units: "Months", initial_value: 12 },
    ],
    miles: 10000,
    months: 12,
  },
  {
    maintenance_id: 9004,
    maintenance_category: "Brakes",
    maintenance_name: "Replace brake fluid",
    maintenance_notes: "Fill for life under normal operating conditions",
    intervals: [],
    miles: null,
    months: null,
  },
];

// Use the SAME mapper the route uses, so a silent change to the mapping
// (e.g. dropping `maintenance_notes`) trips this test instead of slipping
// out to production.
const oemItems: OEMItem[] = fakeDataOneItems.map(toOEMItem);

// The 2019 Ram 1500 from this VIN is an automatic; pin transType so the
// trans_manual filter behaves the way the live route would.
const buckets = triage({
  oemItems,
  carfaxRecords: [],
  shopServiceHistory: [],
  currentMiles: 60000,
  today: new Date("2026-04-28T00:00:00Z"),
  dviFindings: [],
  protractorDeferredWork: [],
  declinedServices: [],
  vehicleYear: 2019,
  vehicleTransType: "Automatic",
});

const allTriaged = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming];

// (1) Inspect row keeps the verb in its title.
const inspectAtf = allTriaged.find(
  (t) => t.serviceKey === "trans_auto" && t.action === "inspect",
);
ok(
  "Inspect ATF row is present in triaged output",
  inspectAtf != null,
  `serviceKey=trans_auto action=inspect; got titles=${allTriaged.filter(t => t.serviceKey === "trans_auto").map(t => `${t.action}/${t.title}`).join(", ")}`,
);
ok(
  "Inspect ATF row keeps the verb 'Inspect' in title",
  !!inspectAtf && /^inspect\b/i.test(inspectAtf.title),
  `title=${inspectAtf?.title}`,
);
ok(
  "Inspect ATF row is NOT recommended-default (we only synthesize for replace/flush rows)",
  !!inspectAtf && !inspectAtf.recommendedDefault,
);

// (2) Lifetime-fluid Replace row → recommendedDefault=true,
//     intervalMiles=120000.
const replaceAtf = allTriaged.find(
  (t) => t.serviceKey === "trans_auto" && t.action === "replace",
);
ok(
  "Replace ATF row is present in triaged output",
  replaceAtf != null,
);
ok(
  "Replace ATF row has recommendedDefault === true",
  replaceAtf?.recommendedDefault === true,
  `recommendedDefault=${replaceAtf?.recommendedDefault}`,
);
ok(
  `Replace ATF row uses LIFETIME_FLUID_DEFAULT_MILES (${LIFETIME_FLUID_DEFAULT_MILES})`,
  replaceAtf?.intervalMiles === LIFETIME_FLUID_DEFAULT_MILES,
  `intervalMiles=${replaceAtf?.intervalMiles}`,
);
ok(
  "Replace ATF row has a recommendedReason explaining the default",
  !!replaceAtf?.recommendedReason && /lifetime/i.test(replaceAtf.recommendedReason),
  `reason=${replaceAtf?.recommendedReason}`,
);

// And the brake-fluid lifetime row should also synthesize the default.
const replaceBrakeFluid = allTriaged.find(
  (t) => t.serviceKey === "brake_fluid" && t.action === "replace",
);
ok(
  "Replace brake-fluid lifetime row is present",
  replaceBrakeFluid != null,
);
ok(
  "Replace brake-fluid row has recommendedDefault=true and uses 120k mi",
  replaceBrakeFluid?.recommendedDefault === true &&
    replaceBrakeFluid?.intervalMiles === LIFETIME_FLUID_DEFAULT_MILES,
  `recommendedDefault=${replaceBrakeFluid?.recommendedDefault} intervalMiles=${replaceBrakeFluid?.intervalMiles}`,
);

// (3) maintenance_notes flows through to the cache shape.
ok(
  "Inspect ATF row carries the dipstick note from DataOne",
  inspectAtf?.notes === "If equipped with dipstick",
  `notes=${JSON.stringify(inspectAtf?.notes)}`,
);

const cachedInspect = inspectAtf ? convertToCache(inspectAtf) : null;
ok(
  "convertToCache preserves notes on the Inspect row",
  cachedInspect?.notes === "If equipped with dipstick",
  `cache.notes=${JSON.stringify(cachedInspect?.notes)}`,
);
ok(
  "convertToCache preserves the parsed action verb on the Inspect row",
  cachedInspect?.action === "inspect",
  `cache.action=${JSON.stringify(cachedInspect?.action)}`,
);

// And the lifetime row's recommended-default fields make it into the cache.
const cachedReplace = replaceAtf ? convertToCache(replaceAtf) : null;
ok(
  "convertToCache preserves recommendedDefault=true on the lifetime row",
  cachedReplace?.recommendedDefault === true,
);
ok(
  "convertToCache preserves intervalMiles=120000 on the lifetime row",
  cachedReplace?.intervalMiles === LIFETIME_FLUID_DEFAULT_MILES,
);
ok(
  "convertToCache preserves the lifetime maintenance_notes on the cache shape",
  cachedReplace?.notes === "Replace if necessary. Lifetime fluid - no scheduled service.",
  `cache.notes=${JSON.stringify(cachedReplace?.notes)}`,
);

// Sanity: the routine 10k oil row should NOT be flagged as a recommended-
// default — it has a real interval and is not a lifetime fluid.
const oil = allTriaged.find((t) => t.serviceKey === "oil");
ok(
  "Routine oil-change row is present and uses the real 10k interval",
  oil?.intervalMiles === 10000 && !oil?.recommendedDefault,
  `intervalMiles=${oil?.intervalMiles} recommendedDefault=${oil?.recommendedDefault}`,
);

if (failed === 0) {
  console.log("\nAll Task #165 plan-build integration checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} Task #165 plan-build integration check(s) failed.`);
  process.exit(1);
}
