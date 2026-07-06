// tests/job-scoring-aces-tiers.smoke.ts
//
// Task #382 — Smoke test for the three ACES scoring tiers in
// `lib/job-scoring.ts`. Pure unit-style: builds VehicleSpecs / job docs in
// memory and asserts the scorer returns the right tier label, score band,
// and breakdown.acesTier discriminator. No DB / network access.

import { scoreJob, SCORE_THRESHOLD_EXACT, type VehicleSpecs } from "@/lib/job-scoring";
import { getMatchConfidenceBadge } from "@/lib/aces-tier-badge";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}

const baseTargetVehicle = {
  vin: "1HGCM82633A123456",
  year: 2018,
  make: "Honda",
  model: "Accord",
};

function specs(over: Partial<VehicleSpecs>): VehicleSpecs {
  return {
    year: 2018,
    make: "honda",
    model: "accord",
    submodel: "ex-l",
    bodyType: "sedan",
    engineDisplacement: "2.0",
    engineCylinders: 4,
    fuelType: "gasoline",
    transmission: "automatic",
    driveType: "fwd",
    gvwrBand: "passenger",
    acesVehicleId: null,
    acesEngineId: null,
    submodelKey: null,
    ...over,
  } as VehicleSpecs;
}

function donorJob(over: any = {}): any {
  return {
    title: "Brake Pad Replacement Front",
    vehicle: { vin: "2HGCM82633A999999", year: 2018, make: "Honda", model: "Accord" },
    job: { title: "Brake Pad Replacement Front" },
    performedAt: new Date().toISOString(),
    shopId: 100,
    ...over,
  };
}

// -- Tier A: exact_aces -----------------------------------------------------
{
  const t = specs({ acesVehicleId: 1234, acesEngineId: 555, submodelKey: "2018|honda|accord|ex-l" });
  const j = specs({ acesVehicleId: 1234, acesEngineId: 555, submodelKey: "2018|honda|accord|ex-l" });
  const r = scoreJob(donorJob(), baseTargetVehicle, t, j, "brake pad");
  if (r.matchScore !== 100) fail(`Tier A expected score 100, got ${r.matchScore}`);
  if (r.matchBand !== "exact") fail(`Tier A expected band exact, got ${r.matchBand}`);
  if (r.matchBandLabel !== "Exact Fit (ACES)") fail(`Tier A expected label "Exact Fit (ACES)", got ${r.matchBandLabel}`);
  if ((r.scoreBreakdown as any).acesTier !== "exact_aces") fail(`Tier A acesTier mismatch: ${(r.scoreBreakdown as any).acesTier}`);
  if (/ACES/i.test(r.matchReason)) fail(`Tier A matchReason must not contain "ACES": ${r.matchReason}`);
  ok("Tier A (exact_aces) returns score 100 with plain-language matchReason");
}

// -- Tier B: engine_match (powertrain) -------------------------------------
{
  const t = specs({ acesVehicleId: 1, acesEngineId: 999, submodelKey: "2018|honda|accord|ex-l" });
  const j = specs({ acesVehicleId: 2, acesEngineId: 999, submodelKey: "2018|honda|accord|sport" });
  // Powertrain title so the engine-shared tier fires.
  const r = scoreJob(donorJob({ title: "Oil Change", job: { title: "Oil Change" } }), baseTargetVehicle, t, j, "oil change");
  if ((r.scoreBreakdown as any).acesTier !== "engine_match") fail(`Tier B acesTier mismatch: ${(r.scoreBreakdown as any).acesTier}`);
  if (r.matchScore < 70) fail(`Tier B expected score >= 70, got ${r.matchScore}`);
  if (/ACES/i.test(r.matchReason)) fail(`Tier B matchReason must not contain "ACES": ${r.matchReason}`);
  ok("Tier B (engine_match) fires for powertrain donor with same engine_id");
}

// -- Tier B does NOT fire for chassis work --------------------------------
{
  const t = specs({ acesVehicleId: 1, acesEngineId: 999, submodelKey: "2018|honda|accord|ex-l" });
  const j = specs({ acesVehicleId: 2, acesEngineId: 999, submodelKey: "2018|honda|accord|sport" });
  const r = scoreJob(donorJob({ title: "Brake Pad Replacement Front" }), baseTargetVehicle, t, j, "brake pad");
  if ((r.scoreBreakdown as any).acesTier === "engine_match") {
    fail("Tier B should NOT fire for chassis work (brakes) — fell through engine gate");
  }
  ok("Tier B correctly skips chassis work — engine_match is powertrain-only");
}

// -- Tier C: submodel_match (chassis) -------------------------------------
{
  const t = specs({ acesVehicleId: 1, acesEngineId: 100, submodelKey: "2018|honda|accord|ex-l" });
  const j = specs({ acesVehicleId: 2, acesEngineId: 200, submodelKey: "2018|honda|accord|ex-l" });
  const r = scoreJob(donorJob({ title: "Brake Pad Replacement Front" }), baseTargetVehicle, t, j, "brake pad");
  if ((r.scoreBreakdown as any).acesTier !== "submodel_match") fail(`Tier C acesTier mismatch: ${(r.scoreBreakdown as any).acesTier}`);
  if (r.matchScore < 60) fail(`Tier C expected score >= 60, got ${r.matchScore}`);
  if (/ACES/i.test(r.matchReason)) fail(`Tier C matchReason must not contain "ACES": ${r.matchReason}`);
  ok("Tier C (submodel_match) fires for chassis donor with same submodelKey");
}

// -- Fall-through: missing IDs should hit legacy heuristic ----------------
{
  const t = specs({});
  const j = specs({});
  const r = scoreJob(donorJob(), baseTargetVehicle, t, j, "brake pad");
  if ((r.scoreBreakdown as any).acesTier !== null) {
    fail(`Fall-through expected acesTier=null, got ${(r.scoreBreakdown as any).acesTier}`);
  }
  ok("Missing ACES IDs falls through to legacy heuristic (acesTier=null)");
}

// -- Advisor-facing badge labels are plain language (no "ACES") ------------
{
  const cases = [
    { in: { sameVinFastPath: true }, label: "VIN Match" },
    { in: { acesTier: "exact_aces" as const }, label: "Verified match" },
    { in: { acesTier: "engine_match" as const }, label: "Strong match" },
    { in: { acesTier: "submodel_match" as const }, label: "Strong match" },
    { in: { acesTier: null }, label: "General match" },
    { in: { gatePass: false }, label: "Not a match" },
  ];
  for (const c of cases) {
    const badge = getMatchConfidenceBadge(c.in);
    if (badge.label !== c.label) {
      fail(`Badge label mismatch for ${JSON.stringify(c.in)}: expected "${c.label}", got "${badge.label}"`);
    }
    if (/ACES/i.test(badge.label) || /ACES/i.test(badge.tooltip)) {
      fail(`Badge for ${JSON.stringify(c.in)} must not contain "ACES": ${badge.label} / ${badge.tooltip}`);
    }
  }
  ok("getMatchConfidenceBadge returns plain-language labels with no ACES jargon");
}

// -- Honest numbers: an off-year, non-ACES heuristic match must not read as a
//    flat 100 "Exact Fit". Even with a strong same-make/same-model/close-year
//    signal plus evidence bonuses (same shop, recent, corroboration) it must be
//    labeled "Great Match" and its score capped below the exact threshold, so a
//    true exact fit always both ranks above and reads above it.
{
  // ACES ids present but non-matching (different vehicle_id AND engine_id) on a
  // powertrain title → no tier fires → legacy heuristic path.
  const t = specs({ acesVehicleId: 10, acesEngineId: 20, submodelKey: "2018|honda|accord|ex-l" });
  const j = specs({ year: 2017, acesVehicleId: 11, acesEngineId: 21, submodelKey: "2017|honda|accord|ex-l" });
  const r = scoreJob(
    donorJob({
      title: "Oil Change",
      job: { title: "Oil Change" },
      vehicle: { vin: "2HGCM82633A999999", year: 2017, make: "Honda", model: "Accord" },
      shopId: 100,
    }),
    baseTargetVehicle,
    t,
    j,
    "oil change",
    { currentShopId: 100, corroboratingCount: 3 },
  );
  if ((r.scoreBreakdown as any).acesTier !== null) {
    fail(`Honest-numbers case expected heuristic path (acesTier=null), got ${(r.scoreBreakdown as any).acesTier}`);
  }
  if (r.matchBand === "exact") fail(`Off-year heuristic must not be band "exact", got ${r.matchBand}`);
  if (r.matchBandLabel === "Exact Fit" || r.matchBandLabel === "Exact Fit (ACES)") {
    fail(`Off-year heuristic must not be labeled Exact Fit, got "${r.matchBandLabel}"`);
  }
  if (r.matchScore >= SCORE_THRESHOLD_EXACT) {
    fail(`Off-year heuristic must be capped below exact threshold (${SCORE_THRESHOLD_EXACT}), got ${r.matchScore}`);
  }
  ok("Off-year non-ACES heuristic is capped below exact threshold and labeled Great Match");
}

console.log("\nALL ACES TIER SMOKE TESTS PASSED");
process.exit(0);
