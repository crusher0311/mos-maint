/**
 * Regression smoke test for Task #364 (category-aware job-match scoring).
 *
 * Run: `npx tsx tests/plan-build-task-364.smoke.ts`
 *
 * Locks in the per-category scoring so chassis / brake / HVAC / wheel-tire
 * / body / electrical work isn't penalized for engine differences, while
 * powertrain work continues to gate diesel-vs-gas and weight engine
 * displacement as it always has:
 *
 *   1. The classifier buckets representative titles into the right
 *      vehicle-system category (suspension / brakes / steering / hvac /
 *      body / electrical / wheel_tire / powertrain), and falls back to
 *      "general" for ambiguous titles.
 *   2. A chassis donor (ball joint) on a same-make+model+close-year target
 *      with a different engine reaches at least the Great Match band
 *      instead of being penalized to Low Confidence.
 *   3. A diesel-vs-gas chassis donor (e.g. a brake job on an F-250) is
 *      NOT gated out — the fuel safety gate only applies to powertrain.
 *   4. A diesel-vs-gas powertrain donor (e.g. a fuel filter) IS still
 *      gated out — powertrain regression is preserved.
 *   5. A same-model powertrain donor with a very different engine size is
 *      still flagged as a "Different engine" material miss (powertrain
 *      regression).
 *   6. A same-model chassis donor with a very different engine size is
 *      NOT flagged as a "Different engine" material miss — the chassis
 *      profile ignores engine signals entirely.
 *   7. The score breakdown surfaces the inferred vehicleSystem and the
 *      engineSignalsApplied / fuelGateApplied flags so the UI can show
 *      "Matched as: Suspension — engine ignored" reasoning.
 *   8. Same-VIN fast path still wins regardless of category, and still
 *      tags the result with the inferred system.
 *   9. Cross-class GVWR penalty still fires for chassis categories
 *      (a heavy-duty donor for a light-duty target).
 */

import {
  scoreJob,
  classifyVehicleSystem,
  getCategoryProfile,
  SCORE_THRESHOLD_LIKELY,
  type VehicleSpecs,
  type VehicleSystem,
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

console.log("Task #364 — Category-aware job-match scoring");

const FIXED_NOW = new Date("2026-05-04T00:00:00Z");

const lightGasSpecs: VehicleSpecs = {
  gvwrBand: "light",
  bodyType: "Pickup",
  driveType: "4WD",
  displacement: 5.0,
  fuelType: "gas",
};
const lightGasSmallEngineSpecs: VehicleSpecs = {
  gvwrBand: "light",
  bodyType: "Pickup",
  driveType: "4WD",
  displacement: 2.7,
  fuelType: "gas",
};
const heavyDieselSpecs: VehicleSpecs = {
  gvwrBand: "heavy",
  bodyType: "Pickup",
  driveType: "4WD",
  displacement: 6.7,
  fuelType: "diesel",
};
const mediumDieselSpecs: VehicleSpecs = {
  gvwrBand: "medium",
  bodyType: "Pickup",
  driveType: "4WD",
  displacement: 6.7,
  fuelType: "diesel",
};
const mediumGasSpecs: VehicleSpecs = {
  gvwrBand: "medium",
  bodyType: "Pickup",
  driveType: "4WD",
  displacement: 6.2,
  fuelType: "gas",
};

// ---------- 1. Classifier ----------
{
  console.log("\n[1] Vehicle-system classifier");
  const cases: Array<[string, VehicleSystem]> = [
    ["Replace front lower ball joints", "suspension"],
    ["Front control arm replacement", "suspension"],
    ["Wheel bearing and hub assembly", "suspension"],
    ["Front brake pads and rotors", "brakes"],
    ["Brake fluid flush", "brakes"],
    ["Steering rack replacement", "steering"],
    ["Power steering pump", "steering"],
    ["Tie rod end replacement", "steering"],
    ["Tire rotation and balance", "wheel_tire"],
    ["TPMS sensor replacement", "wheel_tire"],
    ["Four wheel alignment", "wheel_tire"],
    ["A/C compressor replacement", "hvac"],
    ["Cabin air filter", "hvac"],
    ["Blower motor replacement", "hvac"],
    ["Replace driver door handle", "body"],
    ["Front wiper blades", "body"],
    ["Replace headlight bulb", "body"],
    ["Battery replacement", "electrical"],
    ["Alternator replacement", "electrical"],
    ["Engine oil change", "powertrain"],
    ["Replace timing chain", "powertrain"],
    ["Spark plugs and coil packs", "powertrain"],
    ["Fuel injector cleaning", "powertrain"],
    ["Transmission fluid service", "powertrain"],
    ["Radiator replacement", "powertrain"],
    ["Multi-point inspection", "general"],
    ["Customer concern follow-up", "general"],
  ];
  for (const [title, expected] of cases) {
    const got = classifyVehicleSystem(title);
    ok(`"${title}" => ${expected}`, got === expected, `got ${got}`);
  }

  // Profile correctness — chassis profiles ignore engine, powertrain doesn't.
  const chassis: VehicleSystem[] = [
    "suspension", "brakes", "steering", "wheel_tire", "hvac", "body", "electrical",
  ];
  for (const sys of chassis) {
    const p = getCategoryProfile(sys);
    ok(`${sys} profile: engine ignored`, p.engineSignalsApplied === false);
    ok(`${sys} profile: fuel gate off`, p.fuelGateApplied === false);
  }
  for (const sys of ["powertrain", "general"] as VehicleSystem[]) {
    const p = getCategoryProfile(sys);
    ok(`${sys} profile: engine considered`, p.engineSignalsApplied === true);
    ok(`${sys} profile: fuel gate on`, p.fuelGateApplied === true);
  }
}

// ---------- 2. Chassis donor with different engine still scores well ----------
{
  console.log("\n[2] Chassis donor with different engine reaches Great Match");
  // 2018 F-150 5.0L target, donor is a 2018 F-150 ball joint with 2.7 EcoBoost.
  const target = {
    year: 2018,
    make: "Ford",
    model: "F-150",
    engine: "5.0L V8",
    vin: null,
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-bj-1",
    job: { title: "Replace front lower ball joints" },
    vehicle: { year: 2018, make: "Ford", model: "F-150", engine: "2.7L EcoBoost V6" },
    performedAt: "2026-03-01T00:00:00Z",
  };
  const scored = scoreJob(donor, target, lightGasSpecs, lightGasSmallEngineSpecs, "ball joint", {
    now: FIXED_NOW,
    currentShopId: 25,
  });
  ok("classified as suspension", scored.vehicleSystem === "suspension", `got ${scored.vehicleSystem}`);
  ok("engineSignalsApplied=false in breakdown",
    scored.scoreBreakdown?.engineSignalsApplied === false);
  ok("fuelGateApplied=false in breakdown",
    scored.scoreBreakdown?.fuelGateApplied === false);
  ok("displacement contribution is zero",
    scored.scoreBreakdown?.displacement === 0,
    `got ${scored.scoreBreakdown?.displacement}`);
  ok("gatePass=true", scored.gatePass === true);
  ok(
    `score >= Great Match floor (>=${SCORE_THRESHOLD_LIKELY}); got ${scored.matchScore}`,
    scored.matchScore >= SCORE_THRESHOLD_LIKELY,
  );
  ok("reason does not mention different engine",
    !/different engine/i.test(scored.matchReason),
    scored.matchReason);
}

// ---------- 3. Diesel-vs-gas chassis donor is NOT gated ----------
{
  console.log("\n[3] Diesel-vs-gas chassis donor is not gated");
  // Target: 2019 F-250 gas. Donor: 2019 F-250 diesel brake job.
  const target = {
    year: 2019,
    make: "Ford",
    model: "F-250",
    engine: "6.2L V8",
    vin: null,
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-brake-1",
    job: { title: "Front brake pads and rotors" },
    vehicle: { year: 2019, make: "Ford", model: "F-250", engine: "6.7L Power Stroke Diesel" },
    performedAt: "2026-03-01T00:00:00Z",
  };
  const scored = scoreJob(donor, target, mediumGasSpecs, mediumDieselSpecs, "brake pads", {
    now: FIXED_NOW,
    currentShopId: 25,
  });
  ok("classified as brakes", scored.vehicleSystem === "brakes", `got ${scored.vehicleSystem}`);
  ok("gatePass=true (fuel gate off for chassis)", scored.gatePass === true);
  ok("matchScore > 0", scored.matchScore > 0, `got ${scored.matchScore}`);
  ok("not flagged as Failed Gate",
    scored.matchBandLabel !== "Failed Gate",
    scored.matchBandLabel);
  ok("reason does not mention fuel mismatch",
    !/fuel mismatch/i.test(scored.matchReason),
    scored.matchReason);
}

// ---------- 4. Diesel-vs-gas powertrain donor IS still gated ----------
{
  console.log("\n[4] Diesel-vs-gas powertrain donor is still gated (regression)");
  const target = {
    year: 2019,
    make: "Ford",
    model: "F-250",
    engine: "6.2L V8",
    vin: null,
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-fuel-1",
    job: { title: "Replace fuel filter" },
    vehicle: { year: 2019, make: "Ford", model: "F-250", engine: "6.7L Power Stroke Diesel" },
    performedAt: "2026-03-01T00:00:00Z",
  };
  const scored = scoreJob(donor, target, mediumGasSpecs, mediumDieselSpecs, "fuel filter", {
    now: FIXED_NOW,
  });
  ok("classified as powertrain",
    scored.vehicleSystem === "powertrain", `got ${scored.vehicleSystem}`);
  ok("gatePass=false", scored.gatePass === false);
  ok("score=0", scored.matchScore === 0);
  ok("Failed Gate label", scored.matchBandLabel === "Failed Gate");
  ok("reason mentions fuel mismatch", /fuel mismatch/i.test(scored.matchReason));
}

// ---------- 5. Same-model powertrain donor flags engine mismatch ----------
{
  console.log("\n[5] Same-model powertrain donor still flags Different engine");
  const target = {
    year: 2018,
    make: "Ford",
    model: "F-150",
    engine: "5.0L V8",
    vin: null,
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-tc-1",
    job: { title: "Replace timing chain and tensioners" },
    vehicle: { year: 2018, make: "Ford", model: "F-150", engine: "2.7L EcoBoost V6" },
    performedAt: "2026-03-01T00:00:00Z",
  };
  const scored = scoreJob(donor, target, lightGasSpecs, lightGasSmallEngineSpecs, "timing chain", {
    now: FIXED_NOW,
  });
  ok("classified as powertrain",
    scored.vehicleSystem === "powertrain", `got ${scored.vehicleSystem}`);
  ok("reason mentions Different engine",
    /different engine/i.test(scored.matchReason),
    scored.matchReason);
}

// ---------- 6. Same-model chassis donor does NOT flag engine ----------
{
  console.log("\n[6] Same-model chassis donor does not flag Different engine");
  const target = {
    year: 2018,
    make: "Ford",
    model: "F-150",
    engine: "5.0L V8",
    vin: null,
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-bj-2",
    job: { title: "Replace front lower control arm" },
    vehicle: { year: 2018, make: "Ford", model: "F-150", engine: "2.7L EcoBoost V6" },
    performedAt: "2026-03-01T00:00:00Z",
  };
  const scored = scoreJob(donor, target, lightGasSpecs, lightGasSmallEngineSpecs, "control arm", {
    now: FIXED_NOW,
  });
  ok("classified as suspension",
    scored.vehicleSystem === "suspension", `got ${scored.vehicleSystem}`);
  ok("reason does not flag Different engine",
    !/different engine/i.test(scored.matchReason),
    scored.matchReason);
  ok("displacement contribution is zero",
    scored.scoreBreakdown?.displacement === 0);
}

// ---------- 7. Score breakdown surfaces category metadata ----------
{
  console.log("\n[7] Score breakdown carries category metadata");
  const target = { year: 2018, make: "Ford", model: "F-150", engine: "5.0L V8", vin: null };
  const donor = {
    shopId: 25,
    workOrderId: "wo-meta-1",
    job: { title: "A/C compressor replacement" },
    vehicle: { year: 2018, make: "Ford", model: "F-150", engine: "2.7L EcoBoost V6" },
  };
  const scored = scoreJob(donor, target, lightGasSpecs, lightGasSmallEngineSpecs, "a/c", {
    now: FIXED_NOW,
  });
  ok("vehicleSystem on root", scored.vehicleSystem === "hvac");
  ok("vehicleSystem in breakdown", scored.scoreBreakdown?.vehicleSystem === "hvac");
  ok("engineSignalsApplied=false", scored.scoreBreakdown?.engineSignalsApplied === false);
  ok("fuelGateApplied=false", scored.scoreBreakdown?.fuelGateApplied === false);
}

// ---------- 8. Same-VIN fast path still wins, and tags the system ----------
{
  console.log("\n[8] Same-VIN fast path still wins and tags the system");
  const vin = "2HGFC2F69JH123456";
  const target = { year: 2018, make: "Honda", model: "Civic", engine: "1.5L Turbo I4", vin };
  const donor = {
    shopId: 25,
    workOrderId: "wo-vin-1",
    job: { title: "Replace front brake pads" },
    vehicle: { year: 2018, make: "Honda", model: "Civic", engine: "1.5L Turbo I4", vin },
  };
  const scored = scoreJob(donor, target, null, null, "brake", { now: FIXED_NOW });
  ok("matchScore=100", scored.matchScore === 100);
  ok("Exact Fit", scored.matchBandLabel === "Exact Fit");
  ok("sameVinFastPath=true", scored.sameVinFastPath === true);
  ok("vehicleSystem=brakes", scored.vehicleSystem === "brakes");
}

// ---------- 9. Cross-class GVWR still penalizes chassis categories ----------
{
  console.log("\n[9] Cross-class GVWR penalty still fires for chassis");
  // Light-duty F-150 target, donor is a heavy-duty F-450 ball joint.
  const target = { year: 2018, make: "Ford", model: "F-150", engine: "5.0L V8", vin: null };
  const donor = {
    shopId: 25,
    workOrderId: "wo-cross-1",
    job: { title: "Front lower ball joint" },
    vehicle: { year: 2018, make: "Ford", model: "F-450", engine: "6.7L Power Stroke Diesel" },
  };
  const scored = scoreJob(donor, target, lightGasSpecs, heavyDieselSpecs, "ball joint", {
    now: FIXED_NOW,
  });
  ok("classified as suspension", scored.vehicleSystem === "suspension");
  ok("crossClassPenalized=true", scored.crossClassPenalized === true);
  ok("not Exact Fit", scored.matchBandLabel !== "Exact Fit");
  ok("crossClassMultiplier=0.2", scored.scoreBreakdown?.crossClassMultiplier === 0.2);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll Task #364 assertions passed.");
