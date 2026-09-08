/**
 * Pure regression coverage for CARFAX material-history change detection.
 * Run: npx tsx tests/carfax-material-history-freshness.smoke.ts
 *
 * No database is opened: storage/invalidation behavior consumes this pure
 * predicate after its fetchedAt CAS succeeds.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

async function main() {
  const req = createRequire(import.meta.url);
  const serverOnlyPath = req.resolve("server-only");
  req.cache[serverOnlyPath] = {
    id: serverOnlyPath, filename: serverOnlyPath, loaded: true,
    children: [], paths: [], exports: {},
  } as any;

  const {
    carfaxMaterialRevision,
    estimateMileageFromCarfaxReport,
    hasChangedNormalizedCarfaxContents,
  } = await import("../lib/integrations/carfax");
  const {
    PLAN_CACHE_SCHEMA_VERSION,
    selectValidCachedPlan,
  } = await import("../lib/plan-cache");

  const base = {
    ok: true,
    vin: "1HGCM82633A004352",
    lastReportedMileage: 50_000,
    serviceRecords: [
      { date: "2025-01-01", odometer: 40_000, description: "Oil change" },
      { date: "2026-01-01", odometer: 50_000, description: "Oil change" },
    ],
    recallRecords: [],
  };
  assert.equal(
    hasChangedNormalizedCarfaxContents(base, {
      ...base,
      // Provider envelopes and arrival order are not material history.
      raw: { retriedAt: "different" },
      serviceRecords: [...base.serviceRecords].reverse(),
    }),
    false,
    "duplicate retry with identical normalized records is not material",
  );
  assert.equal(
    hasChangedNormalizedCarfaxContents(base, {
      ...base,
      // The latest mileage can be unchanged while an older service anchor is
      // new, which must still refresh the plan/analysis caches.
      serviceRecords: [
        ...base.serviceRecords,
        { date: "2025-06-01", odometer: 45_000, description: "Brake fluid service" },
      ],
    }),
    true,
    "new service record is material even with unchanged latest mileage",
  );
  assert.equal(
    hasChangedNormalizedCarfaxContents(base, {
      ...base,
      recallRecords: [{
        date: "2026-02-01",
        nhtsaCampaignNumber: "26V-999",
        manufacturerRecallNumber: null,
        description: "Brake hose",
        remedyStatus: "Remedy Available",
        recallType: "Safety",
        text: [],
      }],
    }),
    true,
    "new recall record is material",
  );

  const estimate = estimateMileageFromCarfaxReport(base);
  assert.equal(estimate.estimated, true, "pure estimator preserves cache estimator math");

  const revision = carfaxMaterialRevision(base);
  const candidate = {
    vin: base.vin,
    shopId: 7,
    mileage: 50_000,
    plan: {
      buckets: { overdue: [], dueSoon: [], upcoming: [] },
      vehicle: {},
      currentMiles: 50_000,
      mpdBlended: null,
      customerName: null,
      latestRoNumber: null,
      distanceUnit: "miles" as const,
      soonMiles: 1_000,
      soonDays: 30,
      showInspectItems: true,
      carfaxMaterialRevision: "revision-consumed-before-ingest",
    },
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    schemaVersion: PLAN_CACHE_SCHEMA_VERSION,
  };
  assert.equal(
    selectValidCachedPlan([candidate], {
      vin: base.vin,
      carfaxMaterialRevision: revision,
    }),
    null,
    "a build finishing after ingest cannot serve its obsolete CARFAX revision",
  );
  assert.equal(
    selectValidCachedPlan(
      [{ ...candidate, plan: { ...candidate.plan, carfaxMaterialRevision: revision } }],
      { vin: base.vin, carfaxMaterialRevision: revision },
    )?.vin,
    base.vin,
    "a build carrying the accepted revision remains readable",
  );
  console.log("carfax material-history freshness: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});