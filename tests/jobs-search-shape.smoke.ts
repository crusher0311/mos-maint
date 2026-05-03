/**
 * Snapshot test for the canonical job-search result shape.
 *
 * Run: `npx tsx tests/jobs-search-shape.smoke.ts`
 *
 * `mapServiceJobToCanonicalResult` (extracted from `searchSupabaseServiceJobs`)
 * is the pure mapper that turns a raw normalized_service_jobs row + its line
 * items into the canonical result the dashboard consumes. The end-to-end
 * triple-source collapse (job_index + normalized_mongo + supabase → single
 * canonical query) lands later, but the canonical shape on the read side is
 * already this one — so pinning it now means downstream consumers (dashboard
 * cards, plan-build, recommendations) won't silently break when the collapse
 * happens.
 *
 * Companion to `tests/jobs-search-canonical.smoke.ts`, which pins the no-op
 * guards on the same function.
 */

import { mapServiceJobToCanonicalResult } from "../lib/supabase-job-search";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SHOP_ID = 7;
const SAMPLE_SJ = {
  id: "sj-uuid-001",
  shopId: SHOP_ID,
  workOrderId: "wo-uuid-001",
  title: "Front Brake Pad Replacement",
  description: "Replace front brake pads",
  cannedJobName: "BRAKES_FRONT_PADS",
  laborTotal: "175.00",
  partsTotal: "85.50",
  total: "260.50",
  laborHoursBilled: "1.25",
  laborHoursActual: "1.10",
  provenance: { sourceSystem: "tekmetric" },
  createdAt: new Date("2026-01-15T10:00:00Z"),
  woNumber: 5555,
  woVehicle: {
    vin: "1HGCM82633A123456",
    year: 2018,
    make: "Honda",
    model: "Accord",
    engineDescription: "2.4L L4",
  },
  woVehicleId: "veh-uuid-1",
  woCompletedDate: new Date("2026-01-15T16:00:00Z"),
  woClosedDate: null,
};

const SAMPLE_LINES = [
  {
    lineType: "PART",
    partDescription: "Front Brake Pad Set",
    partNumber: "BP-FR-2018",
    partManufacturer: "ACDelco",
    quantity: "1",
    unitPrice: "85.50",
    extendedPrice: "85.50",
    unitCost: "42.00",
    laborHours: "0",
  },
  {
    lineType: "LABOR",
    partDescription: "Brake pad install labor",
    partNumber: null,
    partManufacturer: null,
    quantity: "1",
    unitPrice: "175.00",
    extendedPrice: "175.00",
    unitCost: "0",
    laborHours: "1.25",
  },
];

async function run() {
  console.log("jobs-search-shape smoke");

  const r = mapServiceJobToCanonicalResult(SAMPLE_SJ, SAMPLE_LINES) as any;

  // Top-level identity
  ok("_id passes through service job id", r._id === "sj-uuid-001");
  ok("shopId is preserved", r.shopId === SHOP_ID);
  ok("vin lifted from work order vehicle", r.vin === "1HGCM82633A123456");
  ok("workOrderId is preserved", r.workOrderId === "wo-uuid-001");
  ok("workOrderNumber lifted from join", r.workOrderNumber === 5555);
  ok("dataSource pinned to 'supabase' (canonical tag)", r.dataSource === "supabase");
  ok("sourceSystem read from provenance", r.sourceSystem === "tekmetric");

  // Vehicle nesting
  ok("vehicle.vin", r.vehicle?.vin === "1HGCM82633A123456");
  ok("vehicle.year", r.vehicle?.year === 2018);
  ok("vehicle.make", r.vehicle?.make === "Honda");
  ok("vehicle.model", r.vehicle?.model === "Accord");
  ok(
    "vehicle.engine prefers engineDescription over engine",
    r.vehicle?.engine === "2.4L L4",
  );

  // Job nesting
  ok("job.title", r.job?.title === "Front Brake Pad Replacement");
  ok("job.description", r.job?.description === "Replace front brake pads");
  ok("job.name prefers cannedJobName", r.job?.name === "BRAKES_FRONT_PADS");
  ok("job.keywords default empty", Array.isArray(r.job?.keywords) && r.job!.keywords.length === 0);

  // Totals (pinned numeric coercion + preference of laborHoursBilled over actual)
  ok("totals.laborAmount parses to 175", r.totals?.laborAmount === 175);
  ok("totals.partsAmount parses to 85.5", r.totals?.partsAmount === 85.5);
  ok("totals.totalAmount parses to 260.5", r.totals?.totalAmount === 260.5);
  ok(
    "totals.laborHours prefers billed over actual (1.25 not 1.10)",
    r.totals?.laborHours === 1.25,
  );
  ok(
    "job.totals matches top-level totals (canonical mirror)",
    JSON.stringify(r.job?.totals) === JSON.stringify(r.totals),
  );

  // Lines
  ok("lines length matches input", r.lines?.length === 2);
  ok("first line is PART", r.lines?.[0]?.lineType === "PART");
  ok("first line description from partDescription", r.lines?.[0]?.description === "Front Brake Pad Set");
  ok("first line partNumber preserved", r.lines?.[0]?.partNumber === "BP-FR-2018");
  ok("first line manufacturer preserved", r.lines?.[0]?.manufacturer === "ACDelco");
  ok("first line numeric coercion: extendedPrice=85.5", r.lines?.[0]?.extendedPrice === 85.5);
  ok("first line numeric coercion: cost=42", r.lines?.[0]?.cost === 42);
  ok("second line is LABOR", r.lines?.[1]?.lineType === "LABOR");
  ok("second line hours coerced", r.lines?.[1]?.hours === 1.25);

  // performedAt prefers completed → closed → createdAt
  ok(
    "performedAt prefers woCompletedDate when present",
    r.performedAt instanceof Date && r.performedAt.toISOString() === "2026-01-15T16:00:00.000Z",
  );

  // performedAt fallback: no completed/closed → createdAt
  {
    const r2 = mapServiceJobToCanonicalResult({ ...SAMPLE_SJ, woCompletedDate: null, woClosedDate: null }, []) as any;
    ok(
      "performedAt falls back to createdAt when no completed/closed dates",
      r2.performedAt instanceof Date && r2.performedAt.toISOString() === "2026-01-15T10:00:00.000Z",
    );
  }

  // Empty lines → empty array (not undefined)
  {
    const r3 = mapServiceJobToCanonicalResult(SAMPLE_SJ, []) as any;
    ok("empty lines array preserved (not undefined)", Array.isArray(r3.lines) && r3.lines.length === 0);
  }

  // Missing provenance.sourceSystem → "unknown"
  {
    const r4 = mapServiceJobToCanonicalResult({ ...SAMPLE_SJ, provenance: null }, []) as any;
    ok("missing provenance falls back to sourceSystem='unknown'", r4.sourceSystem === "unknown");
  }

  if (failed > 0) {
    console.error(`\n${failed} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
