/**
 * Regression smoke test for Task #198.
 *
 * Run: `npx tsx tests/plan-build-task-198.smoke.ts`
 *
 * Covers the new behaviour for OEM "Inspect …" rows on known fluids
 * (e.g. the 2019 Ram 1500 transmission fluid row) and the related copy
 * tightening for OEM lifetime fluids:
 *
 *   1. `isInspectOnlyFluidItem` recognises Inspect rows on the
 *      known-fluid service-key set and rejects everything else.
 *   2. `triage()` flags an OEM Inspect row as `inspectOnly=true` ONLY
 *      when no matching Replace / Flush / Service / Drain row exists for
 *      the same fluid key. When BOTH actions exist, the inspect row
 *      stays a normal inspect row (so it remains hideable via
 *      showInspectItems and we never double-count fluid coverage).
 *   3. Lifetime fluids without intervals still surface as
 *      `recommendedDefault=true` at LIFETIME_FLUID_DEFAULT_MILES, and
 *      the two flags are mutually exclusive (no item is ever both).
 *   4. The plan-cache schema version was bumped to invalidate stale
 *      entries that lack `inspectOnly`.
 */

import {
  triage,
  type OEMItem,
  type TriagedItem,
} from "../lib/plan-build/triage";
import {
  LIFETIME_FLUID_DEFAULT_MILES,
  LIFETIME_FLUID_SERVICE_KEYS,
  isInspectOnlyFluidItem,
  isLifetimeFluidItem,
  parseServiceAction,
} from "../lib/service-keys";
import { PLAN_CACHE_SCHEMA_VERSION } from "../lib/plan-cache";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #198 regression checks");

// ---------------------------------------------------------------------------
// 1. Helper: isInspectOnlyFluidItem is necessary but not sufficient — the
//    triage path must also consult the OEM rows for a sibling Replace.
// ---------------------------------------------------------------------------
ok(
  "Inspect trans_auto on lifetime-key set -> helper true",
  isInspectOnlyFluidItem({ serviceKey: "trans_auto", action: "inspect" }) === true,
);
ok(
  "Inspect coolant on lifetime-key set -> helper true",
  isInspectOnlyFluidItem({ serviceKey: "coolant", action: "inspect" }) === true,
);
ok(
  "Replace trans_auto -> helper false (verb is replace)",
  isInspectOnlyFluidItem({ serviceKey: "trans_auto", action: "replace" }) === false,
);
ok(
  "Inspect on a non-fluid (battery) -> helper false",
  isInspectOnlyFluidItem({ serviceKey: "battery", action: "inspect" }) === false,
);
ok(
  "Inspect on a misc_ key -> helper false",
  isInspectOnlyFluidItem({ serviceKey: "misc_999", action: "inspect" }) === false,
);

// ---------------------------------------------------------------------------
// 2. Real triage() with OEM fixtures — three end-to-end scenarios.
// ---------------------------------------------------------------------------
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

const baseTriageOpts = {
  carfaxRecords: [],
  currentMiles: 80_000,
  today: new Date("2026-01-15T00:00:00Z"),
  dviFindings: [],
  vehicleYear: 2019,
  vehicleTransType: "automatic",
};

// Scenario A: 2019 Ram-style INSPECT-ONLY transmission fluid (no replace row).
{
  const oemItems: OEMItem[] = [
    {
      maintenance_id: 9001,
      name: "Inspect automatic transmission fluid",
      category: "Drivetrain",
      miles: 60_000,
      months: null,
      intervals: [{ units: "Miles", value: 60_000 }],
      notes: "If equipped with dipstick",
    },
    {
      maintenance_id: 9002,
      name: "Replace engine oil and filter",
      category: "Engine",
      miles: 10_000,
      months: 12,
      intervals: [{ units: "Miles", value: 10_000 }, { units: "Months", value: 12 }],
      notes: null,
    },
  ];
  const triaged = triage({ ...baseTriageOpts, oemItems });
  const atf = findItem(triaged, (t) => t.serviceKey === "trans_auto");
  ok(
    "Scenario A: trans_auto row is present in triaged buckets",
    !!atf,
  );
  ok(
    "Scenario A: ATF row is flagged inspectOnly=true",
    atf?.inspectOnly === true,
  );
  ok(
    "Scenario A: ATF row keeps the OEM inspect verb",
    atf?.action === "inspect",
  );
  ok(
    "Scenario A: ATF row keeps the OEM cadence (60k mi, NOT 120k lifetime default)",
    atf?.intervalMiles === 60_000,
  );
  ok(
    "Scenario A: ATF row is NOT flagged recommendedDefault (mutually exclusive)",
    !atf?.recommendedDefault,
  );
  ok(
    "Scenario A: ATF row carries an inspectOnlyReason for the chip tooltip",
    typeof atf?.inspectOnlyReason === "string" && (atf?.inspectOnlyReason?.length ?? 0) > 0,
  );
}

// Scenario B: Inspect AND Replace for the same fluid key — Inspect row must
// NOT be flagged inspectOnly, because the OEM's Replace row already covers
// this fluid and the Inspect row is just routine inspection cadence.
{
  const oemItems: OEMItem[] = [
    {
      maintenance_id: 9101,
      name: "Inspect engine coolant",
      category: "Cooling",
      miles: 15_000,
      months: null,
      intervals: [{ units: "Miles", value: 15_000 }],
      notes: null,
    },
    {
      maintenance_id: 9102,
      name: "Replace engine coolant",
      category: "Cooling",
      miles: 100_000,
      months: null,
      intervals: [{ units: "Miles", value: 100_000 }],
      notes: null,
    },
  ];
  const triaged = triage({ ...baseTriageOpts, oemItems });
  const inspectRow = findItem(
    triaged,
    (t) => t.serviceKey === "coolant" && t.action === "inspect",
  );
  const replaceRow = findItem(
    triaged,
    (t) => t.serviceKey === "coolant" && t.action === "replace",
  );
  ok(
    "Scenario B: both coolant rows survive triage (intra-OEM action dedupe)",
    !!inspectRow && !!replaceRow,
  );
  ok(
    "Scenario B: inspect coolant row is NOT flagged inspectOnly (replace row exists)",
    !inspectRow?.inspectOnly,
  );
  ok(
    "Scenario B: replace coolant row is also NOT flagged inspectOnly",
    !replaceRow?.inspectOnly,
  );
}

// Scenario C: lifetime trans fluid (no intervals at all) — the lifetime
// branch should fire, NOT the inspect-only branch.
{
  const oemItems: OEMItem[] = [
    {
      maintenance_id: 9201,
      name: "Replace automatic transmission fluid",
      category: "Drivetrain",
      miles: null,
      months: null,
      intervals: [],
      notes: "Fill for life - no service required",
    },
  ];
  const triaged = triage({ ...baseTriageOpts, oemItems });
  const atf = findItem(triaged, (t) => t.serviceKey === "trans_auto");
  ok(
    "Scenario C: lifetime ATF row is present",
    !!atf,
  );
  ok(
    "Scenario C: lifetime ATF row is recommendedDefault=true",
    atf?.recommendedDefault === true,
  );
  ok(
    "Scenario C: lifetime ATF row uses the LIFETIME_FLUID_DEFAULT_MILES interval",
    atf?.intervalMiles === LIFETIME_FLUID_DEFAULT_MILES,
  );
  ok(
    "Scenario C: lifetime ATF row is NOT also flagged inspectOnly (mutually exclusive)",
    !atf?.inspectOnly,
  );
  ok(
    "Scenario C: recommendedReason mentions 'shop recommendation' (Task #198 copy)",
    !!atf?.recommendedReason && /shop recommendation/i.test(atf.recommendedReason),
  );
}

// ---------------------------------------------------------------------------
// 3. Sanity: the plan-cache schema bump and the lifetime constants.
// ---------------------------------------------------------------------------
ok(
  "LIFETIME_FLUID_SERVICE_KEYS still includes trans_auto",
  LIFETIME_FLUID_SERVICE_KEYS.has("trans_auto"),
);
ok(
  "LIFETIME_FLUID_SERVICE_KEYS still includes coolant",
  LIFETIME_FLUID_SERVICE_KEYS.has("coolant"),
);
ok(
  "LIFETIME_FLUID_DEFAULT_MILES === 120000",
  LIFETIME_FLUID_DEFAULT_MILES === 120000,
);
ok(
  "PLAN_CACHE_SCHEMA_VERSION >= 4 (cache invalidation for Task #198)",
  PLAN_CACHE_SCHEMA_VERSION >= 4,
);

// ---------------------------------------------------------------------------
// 4. Defensive: parseServiceAction still classifies "Inspect …" / "Check …"
//    correctly so the precomputed replacement set is correct.
// ---------------------------------------------------------------------------
ok(
  "parseServiceAction('Inspect transmission fluid') === 'inspect'",
  parseServiceAction("Inspect transmission fluid") === "inspect",
);
ok(
  "parseServiceAction('Check brake fluid') === 'inspect'",
  parseServiceAction("Check brake fluid") === "inspect",
);
ok(
  "parseServiceAction('Replace engine coolant') === 'replace'",
  parseServiceAction("Replace engine coolant") === "replace",
);

// ---------------------------------------------------------------------------
// 5. isLifetimeFluidItem still classifies the no-intervals lifetime case.
// ---------------------------------------------------------------------------
ok(
  "isLifetimeFluidItem({trans_auto, no intervals}) === true",
  isLifetimeFluidItem({
    serviceKey: "trans_auto",
    name: "Replace transmission fluid",
    notes: null,
    miles: null,
    months: null,
    intervals: [],
  }) === true,
);

if (failed === 0) {
  console.log("\nAll Task #198 regression checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} Task #198 regression check(s) failed.`);
  process.exit(1);
}
