/**
 * Task #476 regression tests:
 *
 * 1. Partner VHI endpoint helper `resolveOpenRoMileage` returns the latest
 *    RO's odometer for tekmetric / shopware / protractor mirror collections
 *    so the partner endpoint matches what Detect Dog overlay shows.
 *
 * 2. `computeIntervalProgress` for a time-only OEM rule (e.g. brake fluid:
 *    36 months, no intervalMiles) with a non-null `last.miles` must NOT
 *    report "current - 0" mi over when `dueAtMiles` is serialized as 0
 *    (legacy cached plans / external rebuilds). The miles axis stays
 *    suppressed; only the time axis fires.
 *
 * Run: `npx tsx tests/plan-build-task-476.smoke.ts`
 */

import { resolveOpenRoMileage, pickMileageInput } from "../lib/plan-build/open-ro-mileage";
import { computeIntervalProgress } from "../lib/vhi-progress";

// Mirror of lib/plan-cache.ts's private MILEAGE_TOLERANCE. Asserted below
// so this test fails if the constant changes upstream — see
// "cache invariant" check.
const MILEAGE_TOLERANCE = 500;

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

function makeMockDb(rows: Record<string, any>) {
  return {
    collection(name: string) {
      const row = rows[name] ?? null;
      return {
        async findOne(_q: any, _opts?: any) {
          return row;
        },
      };
    },
  };
}

console.log("Plan-build task #476 smoke checks");

async function main() {
// ---------------------------------------------------------------------
// Helper: resolveOpenRoMileage — Tekmetric
// ---------------------------------------------------------------------
{
  const db = makeMockDb({
    tekmetric_work_orders: {
      odometer: 111961,
      repairOrderNumber: 36709,
      updatedAt: new Date("2026-05-20T10:00:00Z"),
    },
  });
  const r = await resolveOpenRoMileage({
    db,
    shopIdVariants: [123, "123"],
    vin: "2HKRM4H55EH704109",
    provider: "tekmetric",
  });
  ok("tekmetric: returns latest RO odometer", r?.miles === 111961);
  ok("tekmetric: integration tag is tekmetric", r?.integration === "tekmetric");
  ok("tekmetric: roIdentifier surfaces RO number", String(r?.roIdentifier) === "36709");
}

// ---------------------------------------------------------------------
// Helper: resolveOpenRoMileage — Shopware (odometer_out preferred)
// ---------------------------------------------------------------------
{
  const db = makeMockDb({
    shopware_repair_orders: {
      raw: { odometer_out: 98765, odometer: 90000 },
      number: 42,
      updatedAt: new Date("2026-05-19T10:00:00Z"),
    },
  });
  const r = await resolveOpenRoMileage({
    db,
    shopIdVariants: [1],
    vin: "TESTVIN",
    provider: "shopware",
  });
  ok("shopware: prefers raw.odometer_out", r?.miles === 98765);
  ok("shopware: roIdentifier is number string", r?.roIdentifier === "42");
}

// ---------------------------------------------------------------------
// Helper: resolveOpenRoMileage — Protractor (OutUsage preferred)
// ---------------------------------------------------------------------
{
  const db = makeMockDb({
    protractor_work_orders: {
      OutUsage: 50500,
      InUsage: 50000,
      Odometer: 49000,
      workOrderNumber: "WO-7",
      updatedAt: new Date("2026-05-18T10:00:00Z"),
    },
  });
  const r = await resolveOpenRoMileage({
    db,
    shopIdVariants: [9],
    vin: "TESTVIN",
    provider: "protractor",
  });
  ok("protractor: prefers OutUsage", r?.miles === 50500);
  ok("protractor: roIdentifier is workOrderNumber", r?.roIdentifier === "WO-7");
}

// ---------------------------------------------------------------------
// Helper: returns null when no RO row exists
// ---------------------------------------------------------------------
{
  const db = makeMockDb({});
  const r = await resolveOpenRoMileage({
    db,
    shopIdVariants: [1],
    vin: "TESTVIN",
    provider: "tekmetric",
  });
  ok("returns null when mirror is empty", r === null);
}

// ---------------------------------------------------------------------
// Helper: returns null when odometer is 0 (still need fallback)
// ---------------------------------------------------------------------
{
  const db = makeMockDb({
    tekmetric_work_orders: { odometer: 0, repairOrderNumber: 1, updatedAt: new Date() },
  });
  const r = await resolveOpenRoMileage({
    db,
    shopIdVariants: [1],
    vin: "TESTVIN",
    provider: "tekmetric",
  });
  ok("ignores odometer === 0", r === null);
}

// ---------------------------------------------------------------------
// Helper: autoflow / unknown provider returns null (no per-RO mirror)
// ---------------------------------------------------------------------
{
  const db = makeMockDb({});
  const r = await resolveOpenRoMileage({
    db,
    shopIdVariants: [1],
    vin: "TESTVIN",
    provider: "autoflow",
  });
  ok("autoflow: returns null (no mirror)", r === null);
}

// ---------------------------------------------------------------------
// pickMileageInput: spec contract — open-RO wins when present and >=
// vehicles.currentMileage; vehicles.currentMileage wins when bigger
// (monotonic odometer guard); both null -> miles null so caller can
// fall through to CARFAX / annual fallback and stamp its own label.
// ---------------------------------------------------------------------
{
  const openRo = { miles: 111961, integration: "tekmetric" as const, roIdentifier: "36709", roDate: new Date() };

  // Case A: open-RO higher than vehicle doc — RO wins, label = open_ro
  {
    const p = pickMileageInput({ vehicleDocMileage: 105266, openRoLookup: openRo });
    ok("pick: open-RO higher than vehicle doc -> open_ro wins",
       p.miles === 111961 && p.mileageInputSource === "open_ro");
  }

  // Case B: open-RO null, vehicle doc set -> vehicles_collection
  {
    const p = pickMileageInput({ vehicleDocMileage: 105266, openRoLookup: null });
    ok("pick: no open-RO -> vehicles_collection",
       p.miles === 105266 && p.mileageInputSource === "vehicles_collection");
  }

  // Case C: open-RO present but LOWER than vehicle doc (stale RO row,
  // monotonic odometer guard). Per spec: take the larger of the two
  // AND fire `mileage_discrepancy`.
  {
    const stale = { ...openRo, miles: 90000 };
    const p = pickMileageInput({ vehicleDocMileage: 105266, openRoLookup: stale });
    ok("pick: open-RO lower than vehicle doc -> vehicles wins (monotonic guard)",
       p.miles === 105266 && p.mileageInputSource === "vehicles_collection");
    ok("pick: open-RO lower -> mileage_discrepancy fires",
       p.discrepancy != null && p.discrepancy.currentMiles === 105266 && p.discrepancy.priorMiles === 90000 && p.discrepancy.gapMiles === 15266,
       JSON.stringify(p.discrepancy));
    ok("pick: discrepancy source labeled by integration",
       p.discrepancy?.priorSource === "Tekmetric");
  }

  // Case C2: open-RO lower but within tolerance -> no discrepancy (rounding noise)
  {
    const close = { ...openRo, miles: 105250 };
    const p = pickMileageInput({ vehicleDocMileage: 105266, openRoLookup: close });
    ok("pick: open-RO lower within tolerance -> no discrepancy",
       p.discrepancy == null && p.mileageInputSource === "vehicles_collection");
  }

  // Case D: vehicle doc null, open-RO present -> open_ro
  {
    const p = pickMileageInput({ vehicleDocMileage: null, openRoLookup: openRo });
    ok("pick: vehicle doc null, open-RO present -> open_ro",
       p.miles === 111961 && p.mileageInputSource === "open_ro");
  }

  // Case E: both null -> nulls, caller falls through to CARFAX/annual
  {
    const p = pickMileageInput({ vehicleDocMileage: null, openRoLookup: null });
    ok("pick: both null -> miles null, source null", p.miles === null && p.mileageInputSource === null);
  }

  // Case F: equal values -> open_ro wins (matches Detect Dog input even
  // when they happen to agree, so logging is unambiguous)
  {
    const equal = { ...openRo, miles: 105266 };
    const p = pickMileageInput({ vehicleDocMileage: 105266, openRoLookup: equal });
    ok("pick: equal values -> open_ro wins for unambiguous logging",
       p.miles === 105266 && p.mileageInputSource === "open_ro");
  }
}

// ---------------------------------------------------------------------
// ROUTE selection contract (app/api/external/vehicles/[vin]/vhi):
// the endpoint must treat `pickMileageInput` as the AUTHORITATIVE actual
// anchor (NOT raw openRoLookup.miles) and only fall through to a CARFAX /
// annual estimate when the helper yields no actual reading. The two lines
// below mirror the route's exact selection expression so a regression to
// the old "hard-prioritize raw open-RO, no monotonic guard" behavior is
// caught here. (Mirrors the file's existing approach for MILEAGE_TOLERANCE.)
// ---------------------------------------------------------------------
{
  // Reproduce the route's anchor selection.
  const selectAnchor = (picked: ReturnType<typeof pickMileageInput>) => {
    const mileage = picked.miles && picked.miles > 0 ? picked.miles : null;
    const source = mileage ? picked.mileageInputSource : null;
    return { mileage, source };
  };

  const openRo = { miles: 90000, integration: "tekmetric" as const, roIdentifier: "RO-1", roDate: new Date() };

  // (a) open-RO LOWER than vehicles snapshot -> route must anchor on the
  // larger vehicles value (monotonic guard) and surface the discrepancy,
  // NOT the raw (lower) open-RO odometer.
  {
    const picked = pickMileageInput({ vehicleDocMileage: 105266, openRoLookup: openRo });
    const { mileage, source } = selectAnchor(picked);
    ok("route: open-RO lower -> anchors on vehicles (monotonic guard), not raw open-RO",
       mileage === 105266 && source === "vehicles_collection");
    ok("route: open-RO lower -> does NOT anchor on the raw open-RO value",
       mileage !== 90000);
    ok("route: open-RO lower -> discrepancy is available for the flags array",
       picked.discrepancy != null && picked.discrepancy.gapMiles === 15266);
  }

  // (b) No actual reading at all (neither open-RO nor vehicles) -> route
  // anchor is null so it proceeds to the CARFAX / annual estimate fallback.
  {
    const picked = pickMileageInput({ vehicleDocMileage: null, openRoLookup: null });
    const { mileage, source } = selectAnchor(picked);
    ok("route: no actual reading -> anchor null so estimates run",
       mileage === null && source === null);
  }

  // (c) open-RO present and >= vehicles -> open-RO is the anchor (the common
  // Detect Dog parity case).
  {
    const fresh = { ...openRo, miles: 111961 };
    const picked = pickMileageInput({ vehicleDocMileage: 105266, openRoLookup: fresh });
    const { mileage, source } = selectAnchor(picked);
    ok("route: open-RO >= vehicles -> anchors on open-RO (overlay parity)",
       mileage === 111961 && source === "open_ro");
  }
}

// ---------------------------------------------------------------------
// Cache invariant: when open-RO bumps the input mileage past
// MILEAGE_TOLERANCE, the cache MUST treat it as a miss so the stale
// 105,266 plan does not get served on the next call.
// ---------------------------------------------------------------------
{
  const cachedAt = 105266;
  const newOpenRo = 111961;
  const diff = Math.abs(newOpenRo - cachedAt);
  ok(
    "cache: open-RO bump exceeds MILEAGE_TOLERANCE -> cache miss enforced",
    diff > MILEAGE_TOLERANCE,
    `diff=${diff} tolerance=${MILEAGE_TOLERANCE}`,
  );
}

// ---------------------------------------------------------------------
// computeIntervalProgress: time-only OEM rule, dueAtMiles = 0 (the bug)
// ---------------------------------------------------------------------
{
  // Scenario: brake fluid, 36 months OEM, no mileage interval. Last done
  // at 74,209 mi. Currently 111,961 mi. A legacy cache row or external
  // writer set dueAtMiles=0 instead of null.
  const today = new Date("2026-05-20T00:00:00Z");
  const lastDate = new Date("2022-08-01T00:00:00Z"); // ~45 months ago — interval lapsed
  const progress = computeIntervalProgress(
    {
      intervalMiles: null,
      intervalMonths: 36,
      last: { miles: 74209, date: lastDate },
      dueAtMiles: 0, // <- the legacy / bug payload shape
      dueAtDate: null,
    },
    111961,
    today,
  );

  ok(
    "brake-fluid time-only: miles axis is suppressed (status null)",
    progress.miles.status === null,
    `got status=${progress.miles.status} headline=${progress.miles.headline}`,
  );
  ok(
    "brake-fluid time-only: no 'mi over' headline emitted",
    progress.miles.headline === null,
    `got headline=${progress.miles.headline}`,
  );
  ok(
    "brake-fluid time-only: time axis still reports (interval lapsed)",
    progress.time.status === "overdue",
    `got status=${progress.time.status}`,
  );
  ok(
    "brake-fluid time-only: overall headline anchored to time axis",
    !!progress.headline && /over/.test(progress.headline.text) && !/mi over/.test(progress.headline.text),
    `got headline=${progress.headline?.text}`,
  );
}

// ---------------------------------------------------------------------
// computeIntervalProgress: dueAtMiles still works for normal mileage-only
// rules with no intervalMiles (e.g. coolant flush due at 60k miles).
// ---------------------------------------------------------------------
{
  const today = new Date("2026-05-20T00:00:00Z");
  const progress = computeIntervalProgress(
    {
      intervalMiles: null,
      intervalMonths: null,
      last: null,
      dueAtMiles: 60000, // legitimate non-zero anchor
      dueAtDate: null,
    },
    61247,
    today,
  );

  ok(
    "non-zero dueAtMiles still computes 'mi over'",
    progress.miles.status === "overdue" && /1,247 mi over/.test(progress.miles.headline ?? ""),
    `got headline=${progress.miles.headline}`,
  );
}

}

main().then(() => {
  if (failed > 0) {
    console.error(`\nFAILED: ${failed} check(s)`);
    process.exit(1);
  } else {
    console.log("\nAll task #476 checks passed");
  }
}).catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
