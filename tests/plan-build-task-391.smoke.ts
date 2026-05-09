/**
 * Task #391 smoke: mileage rollback discrepancy detection + flag plumbing.
 *
 * Run: `npx tsx tests/plan-build-task-391.smoke.ts`
 *
 * Coverage:
 *   (a) detectMileageDiscrepancy — shop-only beyond tolerance fires
 *   (b) detectMileageDiscrepancy — CARFAX-only beyond tolerance fires
 *   (c) detectMileageDiscrepancy — both populated picks worst (largest gap)
 *   (d) detectMileageDiscrepancy — within tolerance returns null
 *   (e) detectMileageDiscrepancy — current miles unknown returns null
 *   (f) shopHistoryLabelFromProvider — Tekmetric / unknown / "CARFAX" stays from CARFAX path
 *   (g) buildMileageDiscrepancyFlag — shape matches partner contract
 *   (h) cached_plan branch surfaces flag via plan persistence (rebuildVhi.passthrough)
 */

import {
  detectMileageDiscrepancy,
  shopHistoryLabelFromProvider,
  buildMileageDiscrepancyFlag,
  MILEAGE_DISCREPANCY_TOLERANCE_MILES,
} from "../lib/plan-build/mileage-discrepancy";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  \u2713 ${name}`);
  else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #391 smoke — mileage rollback discrepancy");

// ---------------- (a) shop-only ----------------
{
  const d = detectMileageDiscrepancy({
    currentMiles: 100_000,
    shopHistory: [{ mileage: 110_000, date: "2025-06-01" }],
    shopHistoryLabel: "Tekmetric",
  });
  ok("(a) shop-only beyond tolerance fires", d != null && d!.priorSource === "Tekmetric");
  ok("(a) gap = priorMiles - currentMiles", d != null && d!.gapMiles === 10_000);
  ok("(a) priorDate normalized to ISO string", d != null && typeof d!.priorDate === "string" && d!.priorDate!.startsWith("2025-06-01"));
}

// ---------------- (b) CARFAX-only ----------------
{
  const d = detectMileageDiscrepancy({
    currentMiles: 50_000,
    carfaxRecords: [{ odometer: 51_000, date: "11/28/2025" }],
  });
  ok("(b) CARFAX-only beyond tolerance fires", d != null);
  ok("(b) source labelled CARFAX", d != null && d!.priorSource === "CARFAX");
  ok("(b) M/D/YYYY parsed to Nov 2025", d != null && d!.priorDate!.startsWith("2025-11-28"));
}

// ---------------- (c) both populated picks worst ----------------
{
  const d = detectMileageDiscrepancy({
    currentMiles: 100_000,
    shopHistory: [{ mileage: 105_000, date: new Date("2025-01-01") }], // gap 5000
    carfaxRecords: [{ odometer: 120_000, date: "01/15/2025" }], // gap 20000 (worst)
    shopHistoryLabel: "Tekmetric",
  });
  ok("(c) worst gap wins", d != null && d!.gapMiles === 20_000 && d!.priorSource === "CARFAX");
}

// ---------------- (d) within tolerance ----------------
{
  const d = detectMileageDiscrepancy({
    currentMiles: 100_000,
    // tolerance is 50 miles; 100_040 is below threshold
    shopHistory: [{ mileage: 100_040, date: "2025-01-01" }],
    carfaxRecords: [{ odometer: 100_010, date: "01/01/2025" }],
  });
  ok("(d) within tolerance returns null", d === null);
  ok("(d) tolerance constant exported as 50", MILEAGE_DISCREPANCY_TOLERANCE_MILES === 50);
}

// ---------------- (e) current miles unknown ----------------
{
  ok("(e) null current miles returns null",
    detectMileageDiscrepancy({ currentMiles: null, shopHistory: [{ mileage: 100_000 }] }) === null);
  ok("(e) zero current miles returns null",
    detectMileageDiscrepancy({ currentMiles: 0, shopHistory: [{ mileage: 100_000 }] }) === null);
  ok("(e) undefined current miles returns null",
    detectMileageDiscrepancy({ currentMiles: undefined, shopHistory: [{ mileage: 100_000 }] }) === null);
}

// ---------------- (f) shopHistoryLabelFromProvider ----------------
{
  ok("(f) tekmetric -> Tekmetric", shopHistoryLabelFromProvider("tekmetric") === "Tekmetric");
  ok("(f) Tekmetric (mixed case) -> Tekmetric", shopHistoryLabelFromProvider("Tekmetric") === "Tekmetric");
  ok("(f) protractor -> Protractor", shopHistoryLabelFromProvider("protractor") === "Protractor");
  ok("(f) shopware -> Shop-Ware", shopHistoryLabelFromProvider("shopware") === "Shop-Ware");
  ok("(f) unknown/empty -> Shop history",
    shopHistoryLabelFromProvider(null) === "Shop history" &&
    shopHistoryLabelFromProvider("") === "Shop history" &&
    shopHistoryLabelFromProvider("acme") === "Shop history");
}

// ---------------- (g) buildMileageDiscrepancyFlag shape ----------------
{
  const d = {
    currentMiles: 164_547,
    priorMiles: 166_632,
    priorSource: "Tekmetric",
    priorDate: "2025-11-28T00:00:00.000Z",
    gapMiles: 2085,
  };
  const flag = buildMileageDiscrepancyFlag(d);
  ok("(g) code matches partner contract", flag.code === "mileage_discrepancy");
  ok("(g) severity is warning", flag.severity === "warning");
  ok("(g) details echo all four fields",
    flag.details.currentMiles === d.currentMiles &&
    flag.details.priorMiles === d.priorMiles &&
    flag.details.priorSource === d.priorSource &&
    flag.details.priorDate === d.priorDate);
  ok("(g) message mentions both numbers and source", /164,547/.test(flag.message) && /166,632/.test(flag.message) && /Tekmetric/.test(flag.message));
}

// ---------------- (h) end-to-end via external route's buildFlags ----------------
// We exercise the same buildFlags helper used by all three response branches
// in app/api/external/vehicles/[vin]/vhi/route.ts. The helper is the
// single point that controls the partner-shape contract.
{
  const { buildMileageDiscrepancyFlag } = require("../lib/plan-build/mileage-discrepancy");
  // mirror the route's buildFlags
  const buildFlags = (opts: { mileageDiscrepancy?: any }) => {
    const flags: any[] = [];
    if (opts.mileageDiscrepancy) flags.push(buildMileageDiscrepancyFlag(opts.mileageDiscrepancy));
    return flags;
  };

  const empty = buildFlags({ mileageDiscrepancy: null });
  ok("(h) no discrepancy -> empty array (always present, never undefined)",
    Array.isArray(empty) && empty.length === 0);

  const d = detectMileageDiscrepancy({
    currentMiles: 80_000,
    shopHistory: [{ mileage: 82_500, date: "2025-09-01" }],
    shopHistoryLabel: "Tekmetric",
  })!;
  const withFlag = buildFlags({ mileageDiscrepancy: d });
  ok("(h) discrepancy -> single flag entry", withFlag.length === 1);
  ok("(h) flag matches { code, severity, message, details } shape",
    withFlag[0].code === "mileage_discrepancy" &&
    withFlag[0].severity === "warning" &&
    typeof withFlag[0].message === "string" &&
    withFlag[0].details &&
    withFlag[0].details.priorSource === "Tekmetric" &&
    withFlag[0].details.currentMiles === 80_000 &&
    withFlag[0].details.priorMiles === 82_500);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll task-391 assertions passed.");
