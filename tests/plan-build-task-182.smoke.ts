/**
 * Regression smoke test for Task #182 (job-match scoring recalibration).
 *
 * Run: `npx tsx tests/plan-build-task-182.smoke.ts`
 *
 * Locks in the calibration-driven changes so they can't accidentally regress:
 *   1. Same-VIN donor jobs always land at Exact Fit, even when DataOne
 *      decode is missing on either side.
 *   2. Same make + model + close year (±1) is guaranteed at least Great Match
 *      (likely band) when displacement isn't actively in conflict, even with
 *      no decoded specs.
 *   3. Cross-class safety win is preserved: heavy-duty donor for a
 *      light-duty target is never Exact, and the cross-class flag is set.
 *   4. Fuel safety win is preserved: a diesel donor for a gas vehicle is
 *      gated out (gatePass=false, score=0).
 *   5. Match-reason strip leads with positives and only mentions material
 *      misses — no more "Same make (cross-class, no credit)" noise.
 *   6. Supportive evidence bonuses (recent / same shop / corroborating)
 *      apply, but only push, never override the cross-class penalty.
 *   7. `getScoreBand` still uses the recalibrated thresholds and the
 *      labels stay in sync.
 */

import {
  scoreJob,
  buildCorroborationCounts,
  getScoreBand,
  getBandLabel,
  SCORE_THRESHOLD_EXACT,
  SCORE_THRESHOLD_LIKELY,
  SCORE_THRESHOLD_POSSIBLE,
  type ScoredJob,
  type VehicleSpecs,
} from "../lib/job-scoring";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #182 — Job-match scoring recalibration");

const FIXED_NOW = new Date("2026-04-29T00:00:00Z");
const recentPerformedAt = new Date("2026-04-01T00:00:00Z");
const oldPerformedAt = new Date("2022-04-01T00:00:00Z");

const lightDutySpecs: VehicleSpecs = {
  gvwrBand: "light",
  bodyType: "Sedan",
  driveType: "FWD",
  displacement: 1.5,
  fuelType: "gas",
};
const heavyDutySpecs: VehicleSpecs = {
  gvwrBand: "heavy",
  bodyType: "Pickup",
  driveType: "4WD",
  displacement: 6.7,
  fuelType: "diesel",
};

// ---------- 1. Same-VIN fast path ----------
{
  console.log("\n[1] Same-VIN fast path");
  const target = {
    year: 2018,
    make: "Honda",
    model: "Civic",
    engine: "1.5L Turbo I4",
    vin: "2HGFC2F69JH123456",
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-1",
    job: { title: "Brake pad replacement" },
    vehicle: {
      vin: "2hgfc2f69jh123456", // case + whitespace insensitive
      year: 2018,
      make: "Honda",
      model: "Civic",
      engine: "1.5L Turbo I4",
    },
    performedAt: recentPerformedAt,
  };

  // Decode missing on both sides (the realistic failure case).
  const scored = scoreJob(donor, target, null, null, "brake", { now: FIXED_NOW });
  ok("same VIN scores 100", scored.matchScore === 100, `got ${scored.matchScore}`);
  ok("same VIN -> exact band", scored.matchBand === "exact", `got ${scored.matchBand}`);
  ok("same VIN -> Exact Fit label", scored.matchBandLabel === "Exact Fit");
  ok(
    "same VIN reason leads with positive",
    scored.matchReason.startsWith("Same vehicle (VIN match)"),
    scored.matchReason,
  );
  ok("same VIN sets sameVinFastPath flag", scored.sameVinFastPath === true);
  ok("same VIN gatePass is true", scored.gatePass === true);

  // Same VIN with whitespace differences
  const donorPadded = {
    ...donor,
    vehicle: { ...donor.vehicle, vin: "  2HGFC2F69JH123456  " },
  };
  const padded = scoreJob(donorPadded, target, null, null, "brake", { now: FIXED_NOW });
  ok(
    "same VIN with whitespace still hits fast path",
    padded.matchScore === 100 && padded.matchBand === "exact",
  );

  // Same VIN but the engine strings parse to different fuels (typo, partial
  // decode, garbled "Diesel" suffix on a gas car, etc). The fuel safety gate
  // would otherwise drop this — the same VIN must beat the fuel gate because
  // it's still the same physical vehicle.
  const dieselTypoTarget = { ...target, engine: "1.5L Turbo I4" };
  const dieselTypoDonor = {
    ...donor,
    vehicle: { ...donor.vehicle, engine: "1.5L Cummins Diesel (mis-entry)" },
  };
  const fuelDisagreement = scoreJob(
    dieselTypoDonor,
    dieselTypoTarget,
    null,
    null,
    "brake",
    { now: FIXED_NOW },
  );
  ok(
    "same VIN survives fuel-mismatch gate (engine strings disagree)",
    fuelDisagreement.matchScore === 100 && fuelDisagreement.matchBand === "exact",
    `score=${fuelDisagreement.matchScore}, band=${fuelDisagreement.matchBand}, gatePass=${fuelDisagreement.gatePass}`,
  );
  ok(
    "same VIN over fuel-mismatch still gatePass=true",
    fuelDisagreement.gatePass === true,
  );

  // Defence-in-depth: same VIN with explicit DataOne specs that disagree on
  // fuel must also survive the fuel gate.
  const tGasSpecs: VehicleSpecs = {
    gvwrBand: "light", bodyType: "Sedan", driveType: "FWD",
    displacement: 1.5, fuelType: "gas",
  };
  const jDieselSpecs: VehicleSpecs = {
    gvwrBand: "light", bodyType: "Sedan", driveType: "FWD",
    displacement: 1.5, fuelType: "diesel",
  };
  const fuelSpecsDisagreement = scoreJob(
    donor, target, tGasSpecs, jDieselSpecs, "brake", { now: FIXED_NOW },
  );
  ok(
    "same VIN survives fuel-mismatch gate (DataOne specs disagree)",
    fuelSpecsDisagreement.matchScore === 100 && fuelSpecsDisagreement.matchBand === "exact",
    `score=${fuelSpecsDisagreement.matchScore}, band=${fuelSpecsDisagreement.matchBand}`,
  );

  // Partial-VIN safety: a 12-char or 11-char "VIN" (squish or truncated)
  // matching a full VIN's prefix must NOT trip the Exact Fit fast path.
  // Real VINs are exactly 17 chars; anything else is a data-quality artefact.
  const partialVinTarget = { ...target, vin: "2HGFC2F69JH" }; // 11 chars
  const partialVinDonor = {
    ...donor,
    vehicle: { ...donor.vehicle, vin: "2HGFC2F69JH" },
  };
  const partial = scoreJob(partialVinDonor, partialVinTarget, null, null, "brake", {
    now: FIXED_NOW,
  });
  ok(
    "partial VINs (<17 chars) do NOT hit fast path",
    partial.sameVinFastPath !== true,
    `sameVinFastPath=${partial.sameVinFastPath}, score=${partial.matchScore}`,
  );

  // VIN with invalid characters (I/O/Q are forbidden in real VINs) should
  // also fall through to the regular scoring path.
  const invalidCharsTarget = { ...target, vin: "2HGFC2F69IH123456" }; // contains 'I'
  const invalidCharsDonor = {
    ...donor,
    vehicle: { ...donor.vehicle, vin: "2HGFC2F69IH123456" },
  };
  const invalid = scoreJob(invalidCharsDonor, invalidCharsTarget, null, null, "brake", {
    now: FIXED_NOW,
  });
  ok(
    "VINs with forbidden chars (I/O/Q) do NOT hit fast path",
    invalid.sameVinFastPath !== true,
    `sameVinFastPath=${invalid.sameVinFastPath}`,
  );
}

// ---------- 2. Same make + model + ±1 year guarantee ----------
{
  console.log("\n[2] Same make+model+year guarantee even without DataOne decode");
  const target = {
    year: 2020,
    make: "Toyota",
    model: "Camry",
    engine: null,
    vin: "4T1B11HK0LU111111",
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-2",
    job: { title: "Replace front brake pads" },
    vehicle: {
      vin: "4T1B11HK0LU222222", // different VIN, same Y/M/M
      year: 2021,
      make: "Toyota",
      model: "Camry",
      engine: null,
    },
    performedAt: recentPerformedAt,
  };

  // No DataOne specs on either side — this is the bug the task calls out.
  const scored = scoreJob(donor, target, null, null, "brake", { now: FIXED_NOW });
  ok(
    `same make+model+1y guaranteed >= Likely (${SCORE_THRESHOLD_LIKELY})`,
    scored.matchScore >= SCORE_THRESHOLD_LIKELY,
    `got score=${scored.matchScore}, band=${scored.matchBand}`,
  );
  ok(
    "same make+model+1y band is likely or exact",
    scored.matchBand === "likely" || scored.matchBand === "exact",
    `got ${scored.matchBand}`,
  );
  ok(
    "reason leads with a positive (Same * or Recent)",
    /^Same|^Recent/.test(scored.matchReason),
    scored.matchReason,
  );
  ok(
    "reason mentions 'Same model'",
    /same model/i.test(scored.matchReason),
    scored.matchReason,
  );
  ok(
    "reason does NOT contain noisy 'partial class data'",
    !/partial class data|class unknown|cross-class, no credit/i.test(scored.matchReason),
    scored.matchReason,
  );

  // Same model, exact year, same engine — should be solidly Exact even without specs
  const donorExact = {
    ...donor,
    vehicle: { ...donor.vehicle, year: 2020 },
  };
  const exactish = scoreJob(donorExact, target, null, null, "brake", {
    now: FIXED_NOW,
    currentShopId: 25,
  });
  ok(
    `same model + same year + same shop reaches Exact (>= ${SCORE_THRESHOLD_EXACT})`,
    exactish.matchScore >= SCORE_THRESHOLD_EXACT,
    `got ${exactish.matchScore}`,
  );
}

// ---------- 3. Cross-class safety: heavy-duty for light-duty target ----------
{
  console.log("\n[3] Cross-class safety");
  const target = {
    year: 2020,
    make: "Ford",
    model: "F-150",
    engine: "5.0L V8",
    vin: "1FTFW1E55LFA00001",
  };
  const heavyDonor = {
    shopId: 25,
    workOrderId: "wo-3",
    job: { title: "Replace front brake pads" },
    vehicle: {
      vin: "1FT8W3DT5LEC22222",
      year: 2020,
      make: "Ford",
      model: "F-350",
      engine: "6.7L V8 Power Stroke Diesel",
    },
    performedAt: recentPerformedAt,
  };

  // Pretend DataOne resolved both sides with the right classes
  const lightTargetSpecs: VehicleSpecs = {
    gvwrBand: "light",
    bodyType: "Pickup",
    driveType: "4WD",
    displacement: 5.0,
    fuelType: "gas",
  };
  const scored = scoreJob(heavyDonor, target, lightTargetSpecs, heavyDutySpecs, "brake", {
    now: FIXED_NOW,
    currentShopId: 25,
  });
  // Diesel donor for gas target should fuel-gate first.
  ok("diesel donor for gas target -> gatePass=false", scored.gatePass === false);
  ok("fuel gate -> Failed Gate label", scored.matchBandLabel === "Failed Gate");
  ok("fuel gate -> score 0", scored.matchScore === 0);

  // Now test cross-class without the diesel issue — heavy gas donor
  const heavyGasDonor = {
    ...heavyDonor,
    vehicle: { ...heavyDonor.vehicle, engine: "6.2L V8" },
  };
  const heavyGasSpecs: VehicleSpecs = { ...heavyDutySpecs, fuelType: "gas", displacement: 6.2 };
  const scored2 = scoreJob(heavyGasDonor, target, lightTargetSpecs, heavyGasSpecs, "brake", {
    now: FIXED_NOW,
    currentShopId: 25,
  });
  ok("cross-class flag is set", scored2.crossClassPenalized === true);
  ok(
    "cross-class never lands at Exact",
    scored2.matchBand !== "exact",
    `got band=${scored2.matchBand}, score=${scored2.matchScore}`,
  );
  ok(
    "cross-class reason mentions 'Different class'",
    /different class/i.test(scored2.matchReason),
    scored2.matchReason,
  );
}

// ---------- 4. Fuel-gate diesel-vs-gas ----------
{
  console.log("\n[4] Fuel safety gate");
  const target = {
    year: 2019,
    make: "Ram",
    model: "1500",
    engine: "5.7L V8 HEMI",
    vin: "1C6RR6FG7KS516181",
  };
  const dieselDonor = {
    shopId: 25,
    workOrderId: "wo-4",
    job: { title: "Replace fuel filter" },
    vehicle: {
      vin: "3C6UR5DL3MG999999",
      year: 2021,
      make: "Ram",
      model: "2500",
      engine: "6.7L Cummins Diesel",
    },
    performedAt: recentPerformedAt,
  };
  const scored = scoreJob(dieselDonor, target, null, null, "fuel filter", { now: FIXED_NOW });
  ok("diesel-vs-gas (parsed from engine string) gate-fails", scored.gatePass === false);
  ok("diesel-vs-gas score is 0", scored.matchScore === 0);
}

// ---------- 5. Match-reason strip — positives first, no noise ----------
{
  console.log("\n[5] Match-reason format");
  const target = {
    year: 2020,
    make: "Toyota",
    model: "Camry",
    engine: "2.5L I4",
    vin: "4T1B11HK0LU111111",
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-5",
    job: { title: "Replace front brake pads" },
    vehicle: {
      vin: "4T1B11HK0LU222222",
      year: 2020,
      make: "Toyota",
      model: "Camry",
      engine: "2.5L I4",
    },
    performedAt: recentPerformedAt,
  };
  const scored = scoreJob(donor, target, lightDutySpecs, lightDutySpecs, "brake", {
    now: FIXED_NOW,
    currentShopId: 25,
  });
  ok(
    "reason does not contain pipe separator anymore",
    !scored.matchReason.includes(" | "),
    scored.matchReason,
  );
  ok(
    "reason starts with 'Same'",
    scored.matchReason.startsWith("Same"),
    scored.matchReason,
  );
  ok(
    "reason mentions 'Same shop' when shopId matches",
    /same shop/i.test(scored.matchReason),
    scored.matchReason,
  );
  ok(
    "reason mentions 'Recent' when donor is fresh",
    /recent/i.test(scored.matchReason),
    scored.matchReason,
  );
  ok(
    "reason does NOT contain 'cross-class, no credit'",
    !/cross-class, no credit/i.test(scored.matchReason),
    scored.matchReason,
  );
}

// ---------- 6. Evidence bonuses are bounded and never override cross-class ----------
{
  console.log("\n[6] Evidence bonuses behavior");
  const target = {
    year: 2020,
    make: "Honda",
    model: "Civic",
    engine: "1.5L I4",
    vin: "2HGFC2F69LH444444",
  };
  const donorBase = {
    shopId: 25,
    workOrderId: "wo-6",
    job: { title: "Brake pad replacement" },
    vehicle: {
      vin: "2HGFC2F69LH555555",
      year: 2020,
      make: "Honda",
      model: "Civic",
      engine: "1.5L I4",
    },
  };

  // Old donor, different shop, no corroboration
  const baseline = scoreJob(
    { ...donorBase, performedAt: oldPerformedAt },
    target,
    null,
    null,
    "brake",
    { now: FIXED_NOW, currentShopId: 99, corroboratingCount: 1 },
  );
  // Recent, same shop, lots of corroboration
  const boosted = scoreJob(
    { ...donorBase, performedAt: recentPerformedAt },
    target,
    null,
    null,
    "brake",
    { now: FIXED_NOW, currentShopId: 25, corroboratingCount: 5 },
  );
  ok(
    "evidence bonuses raise the score",
    boosted.matchScore > baseline.matchScore,
    `boosted=${boosted.matchScore}, baseline=${baseline.matchScore}`,
  );
  ok(
    "evidence bonus is recorded in the breakdown",
    (boosted.scoreBreakdown?.evidenceBonus ?? 0) > 0,
  );
  ok(
    "evidence bonus is bounded (recent 5 + same shop 5 + corroboration ≤6 = ≤16)",
    (boosted.scoreBreakdown?.evidenceBonus ?? 0) <= 16,
    `bonus=${boosted.scoreBreakdown?.evidenceBonus}`,
  );

  // Cross-class case — bonuses should be suppressed
  const crossTarget = {
    year: 2020,
    make: "Ford",
    model: "F-150",
    engine: "5.0L V8",
    vin: "1FTFW1E55LFA00001",
  };
  const crossDonor = {
    shopId: 25,
    workOrderId: "wo-6b",
    job: { title: "Brake pad replacement" },
    vehicle: {
      vin: "1FT8W3DT5LEC22222",
      year: 2020,
      make: "Ford",
      model: "F-350",
      engine: "6.2L V8",
    },
    performedAt: recentPerformedAt,
  };
  const crossSpecs: VehicleSpecs = { ...heavyDutySpecs, fuelType: "gas", displacement: 6.2 };
  const lightTargetSpecs: VehicleSpecs = {
    gvwrBand: "light",
    bodyType: "Pickup",
    driveType: "4WD",
    displacement: 5.0,
    fuelType: "gas",
  };
  const crossScored = scoreJob(crossDonor, crossTarget, lightTargetSpecs, crossSpecs, "brake", {
    now: FIXED_NOW,
    currentShopId: 25,
    corroboratingCount: 5,
  });
  ok(
    "cross-class case applies NO evidence bonus",
    (crossScored.scoreBreakdown?.evidenceBonus ?? 0) === 0,
    `bonus=${crossScored.scoreBreakdown?.evidenceBonus}`,
  );
  ok(
    "cross-class still penalised even with would-be bonuses",
    crossScored.matchBand !== "exact",
    `band=${crossScored.matchBand}`,
  );
}

// ---------- 7. Score band thresholds + labels ----------
{
  console.log("\n[7] Band thresholds and labels");
  ok("threshold exact = 80", SCORE_THRESHOLD_EXACT === 80);
  ok("threshold likely = 55", SCORE_THRESHOLD_LIKELY === 55);
  ok("threshold possible = 35", SCORE_THRESHOLD_POSSIBLE === 35);
  ok("score 95 -> exact", getScoreBand(95) === "exact");
  ok("score 80 -> exact (boundary)", getScoreBand(80) === "exact");
  ok("score 79 -> likely", getScoreBand(79) === "likely");
  ok("score 55 -> likely (boundary)", getScoreBand(55) === "likely");
  ok("score 54 -> possible", getScoreBand(54) === "possible");
  ok("score 35 -> possible (boundary)", getScoreBand(35) === "possible");
  ok("score 34 -> low_confidence", getScoreBand(34) === "low_confidence");
  ok("label exact = 'Exact Fit'", getBandLabel("exact") === "Exact Fit");
  ok("label likely = 'Great Match'", getBandLabel("likely") === "Great Match");
  ok("label possible = 'Good Match'", getBandLabel("possible") === "Good Match");
  ok("label low_confidence = 'Low Confidence'", getBandLabel("low_confidence") === "Low Confidence");
}

// ---------- 8. buildCorroborationCounts groups by title + Y/M ----------
{
  console.log("\n[8] Corroboration counter helper");
  const jobs = [
    { _id: "a", job: { title: "Brake Pad Replacement" }, vehicle: { make: "Honda", model: "Civic" } },
    { _id: "b", job: { title: "brake pad replacement" }, vehicle: { make: "Honda", model: "Civic" } },
    { _id: "c", job: { title: "Brake pad replacement" }, vehicle: { make: "Honda", model: "Accord" } },
    { _id: "d", job: { title: "Oil change" }, vehicle: { make: "Honda", model: "Civic" } },
  ];
  const counts = buildCorroborationCounts(jobs, (j) => j._id);
  ok("a corroborates with b (same title+Y/M)", counts.get("a") === 2 && counts.get("b") === 2);
  ok("c is alone (different model)", counts.get("c") === 1);
  ok("d is alone (different title)", counts.get("d") === 1);
}

if (failed > 0) {
  console.error(`\nFAILED ${failed} assertion(s)`);
  process.exit(1);
}
console.log("\nAll Task #182 smoke checks passed.");
