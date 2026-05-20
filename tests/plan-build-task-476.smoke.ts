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

import { resolveOpenRoMileage } from "../lib/plan-build/open-ro-mileage";
import { computeIntervalProgress } from "../lib/vhi-progress";

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
