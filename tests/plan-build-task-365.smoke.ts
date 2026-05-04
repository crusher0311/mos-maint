/**
 * Regression smoke test for Task #365 (platform/chassis sibling-model
 * matching).
 *
 * Run: `npx tsx tests/plan-build-task-365.smoke.ts`
 *
 * Locks in platform/chassis-family grouping so sibling-model donor jobs on
 * the same platform get meaningful match credit for chassis-shareable work
 * (suspension / brakes / steering / hvac / body / wheel-tire), without
 * over-matching for powertrain or unrelated categories:
 *
 *   1. resolvePlatform() returns the expected platform id for each
 *      seeded family (GM K2XX SUVs, GM T1XX SUVs, GM K2XX trucks, Ford
 *      P415/P702 fullsize, Super Duty, Wrangler/Gladiator, WK2/Durango,
 *      Toyota Tacoma/4Runner, Camry/ES, RAV4/NX, Highlander/RX, Honda
 *      Pilot/Ridgeline/Passport, Civic/CR-V).
 *   2. Out-of-range or unknown vehicles fall back to null cleanly.
 *   3. Chassis donor (Suburban ball-joint) on a Tahoe target with the
 *      same year reaches at least the Great Match band, with the match
 *      reason mentioning the platform.
 *   4. Powertrain donor on a sibling model does NOT get platform credit
 *      (a Suburban transmission donor for a Tahoe target is not boosted).
 *   5. Unknown-platform vehicles preserve today's category-aware
 *      behavior (no regression).
 *   6. Cross-class GVWR penalty still applies even when platform credit
 *      would otherwise fire (safety win preserved).
 *   7. Score breakdown carries targetPlatform / donorPlatform /
 *      platformCreditApplied so the UI can surface "why" reasoning.
 *   8. True same-model matches still outrank platform-sibling matches.
 */

import {
  scoreJob,
  SCORE_THRESHOLD_LIKELY,
  type VehicleSpecs,
} from "../lib/job-scoring";
import { resolvePlatform, isPlatformShareableSystem } from "../lib/vehicle-platform";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #365 — Platform/chassis sibling-model matching");

const FIXED_NOW = new Date("2026-05-04T00:00:00Z");

const lightGasSpecs: VehicleSpecs = {
  gvwrBand: "light",
  bodyType: "SUV",
  driveType: "4WD",
  displacement: 5.3,
  fuelType: "gas",
};
const lightGasAltSpecs: VehicleSpecs = {
  gvwrBand: "light",
  bodyType: "SUV",
  driveType: "4WD",
  displacement: 6.2,
  fuelType: "gas",
};
const heavyDieselSpecs: VehicleSpecs = {
  gvwrBand: "heavy",
  bodyType: "Pickup",
  driveType: "4WD",
  displacement: 6.7,
  fuelType: "diesel",
};

// ---------- 1. Platform resolver coverage ----------
{
  console.log("\n[1] Platform resolver coverage");
  const cases: Array<[number, string, string, string | null]> = [
    // GM K2XX SUVs
    [2018, "Chevrolet", "Tahoe", "GMT-K2XX"],
    [2018, "Chevrolet", "Suburban", "GMT-K2XX"],
    [2018, "GMC", "Yukon XL", "GMT-K2XX"],
    [2018, "Cadillac", "Escalade", "GMT-K2XX"],
    [2017, "Chevy", "Silverado 1500", "GMT-K2XX"],
    // GM T1XX
    [2022, "Chevrolet", "Tahoe", "GMT-T1XX-SUV"],
    [2022, "GMC", "Yukon", "GMT-T1XX-SUV"],
    [2022, "Chevrolet", "Silverado 1500", "GMT-T1XX-Truck"],
    // GM HD — exercise edge years and trim variants so the HD regex always
    // wins over the 1500-truck stem regardless of where the year band lands.
    [2015, "Chevrolet", "Silverado 2500HD", "GMT-K2HD"],
    [2018, "Chevrolet", "Silverado 2500HD", "GMT-K2HD"],
    [2019, "GMC", "Sierra 2500", "GMT-K2HD"],
    [2014, "Chevrolet", "Silverado 2500HD", null], // year too early
    [2020, "Chevrolet", "Silverado 3500HD", "GMT-T1HD"],
    [2022, "GMC", "Sierra 3500", "GMT-T1HD"],
    [2024, "Chevrolet", "Silverado 2500", "GMT-T1HD"],
    // Ford fullsize
    [2018, "Ford", "F-150", "Ford-T3-Fullsize"],
    [2019, "Ford", "Expedition", "Ford-T3-Fullsize"],
    [2022, "Lincoln", "Navigator", "Ford-T6-Fullsize"],
    [2023, "Ford", "F-150", "Ford-T6-Fullsize"],
    // Ford Super Duty
    [2020, "Ford", "F-250", "Ford-SuperDuty-P558"],
    [2024, "Ford", "F-350", "Ford-SuperDuty-2023"],
    // Jeep / Mopar
    [2021, "Jeep", "Wrangler", "Jeep-JL-JT"],
    [2022, "Jeep", "Gladiator", "Jeep-JL-JT"],
    [2018, "Jeep", "Grand Cherokee", "Mopar-WK2-WD"],
    [2018, "Dodge", "Durango", "Mopar-WK2-WD"],
    // Toyota
    [2019, "Toyota", "Tacoma", "Toyota-Midsize-BOF"],
    [2019, "Toyota", "4Runner", "Toyota-Midsize-BOF"],
    [2020, "Toyota", "Tundra", "Toyota-Fullsize-Gen2"],
    [2020, "Toyota", "Sequoia", "Toyota-Fullsize-Gen2"],
    [2023, "Toyota", "Tundra", "Toyota-TNGA-F-Fullsize"],
    [2020, "Toyota", "Camry", "Toyota-TNGA-K-Sedan"],
    [2020, "Lexus", "ES350", "Toyota-TNGA-K-Sedan"],
    [2021, "Toyota", "RAV4", "Toyota-TNGA-K-CUV"],
    [2022, "Lexus", "NX 350", "Toyota-TNGA-K-CUV"],
    [2022, "Toyota", "Highlander", "Toyota-TNGA-K-LargeCUV"],
    [2022, "Lexus", "RX 350", "Toyota-TNGA-K-LargeCUV"],
    // Honda
    [2020, "Honda", "Pilot", "Honda-GLT"],
    [2020, "Honda", "Ridgeline", "Honda-GLT"],
    [2020, "Honda", "Passport", "Honda-GLT"],
    [2018, "Honda", "Civic", "Honda-CGP-2016"],
    [2019, "Honda", "CR-V", "Honda-CGP-2016"],
    // Out of range / unknown
    [2010, "Chevrolet", "Tahoe", null],
    [2024, "Honda", "Civic", null],
    [2020, "Tesla", "Model 3", null],
    [2020, "Mazda", "CX-5", null],
  ];
  for (const [year, make, model, expected] of cases) {
    const got = resolvePlatform(year, make, model);
    const gotId = got?.id ?? null;
    ok(`${year} ${make} ${model} => ${expected}`, gotId === expected, `got ${gotId}`);
  }

  ok("nulls when missing year", resolvePlatform(null, "Chevrolet", "Tahoe") === null);
  ok("nulls when missing make", resolvePlatform(2018, null, "Tahoe") === null);
  ok("nulls when missing model", resolvePlatform(2018, "Chevrolet", null) === null);

  // Chassis-shareable membership
  for (const sys of ["suspension", "brakes", "steering", "hvac", "body", "wheel_tire"]) {
    ok(`${sys} is platform-shareable`, isPlatformShareableSystem(sys));
  }
  for (const sys of ["powertrain", "electrical", "general"]) {
    ok(`${sys} is NOT platform-shareable`, !isPlatformShareableSystem(sys));
  }
}

// ---------- 2. Suburban ball-joint donor for Tahoe target -> Great Match ----------
{
  console.log("\n[2] Sibling-model chassis donor reaches Great Match");
  const target = {
    year: 2018,
    make: "Chevrolet",
    model: "Tahoe",
    engine: "5.3L V8",
    vin: null,
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-bj-sub",
    job: { title: "Replace front lower ball joints" },
    vehicle: {
      year: 2018,
      make: "Chevrolet",
      model: "Suburban",
      engine: "5.3L V8",
    },
    performedAt: "2026-03-01T00:00:00Z",
  };
  const scored = scoreJob(donor, target, lightGasSpecs, lightGasSpecs, "ball joint", {
    now: FIXED_NOW,
    currentShopId: 25,
  });
  ok("vehicleSystem=suspension", scored.vehicleSystem === "suspension");
  ok("platformCreditApplied=true", scored.scoreBreakdown?.platformCreditApplied === true);
  ok(
    "targetPlatform=GMT-K2XX",
    scored.scoreBreakdown?.targetPlatform === "GMT-K2XX",
    `got ${scored.scoreBreakdown?.targetPlatform}`,
  );
  ok(
    "donorPlatform=GMT-K2XX",
    scored.scoreBreakdown?.donorPlatform === "GMT-K2XX",
    `got ${scored.scoreBreakdown?.donorPlatform}`,
  );
  ok(
    `score >= Great Match floor (${SCORE_THRESHOLD_LIKELY}); got ${scored.matchScore}`,
    scored.matchScore >= SCORE_THRESHOLD_LIKELY,
  );
  ok(
    "reason mentions platform",
    /Same platform: GMT-K2XX/.test(scored.matchReason),
    scored.matchReason,
  );
  ok(
    "reason mentions Suburban -> Tahoe",
    /Suburban\s*\u2192\s*Tahoe/.test(scored.matchReason),
    scored.matchReason,
  );
}

// ---------- 3. Powertrain sibling donor does NOT get platform credit ----------
{
  console.log("\n[3] Powertrain sibling donor does not get platform credit");
  const target = {
    year: 2018,
    make: "Chevrolet",
    model: "Tahoe",
    engine: "5.3L V8",
    vin: null,
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-trans-sub",
    job: { title: "Transmission fluid service" },
    vehicle: {
      year: 2018,
      make: "Chevrolet",
      model: "Suburban",
      engine: "6.2L V8",
    },
    performedAt: "2026-03-01T00:00:00Z",
  };
  const scored = scoreJob(donor, target, lightGasSpecs, lightGasAltSpecs, "transmission", {
    now: FIXED_NOW,
  });
  ok("vehicleSystem=powertrain", scored.vehicleSystem === "powertrain");
  ok(
    "platformCreditApplied=false",
    scored.scoreBreakdown?.platformCreditApplied === false,
  );
  ok(
    "reason does NOT mention platform",
    !/Same platform/.test(scored.matchReason),
    scored.matchReason,
  );
  // Both platforms still resolve, they're just not credited.
  ok(
    "targetPlatform still surfaced in breakdown",
    scored.scoreBreakdown?.targetPlatform === "GMT-K2XX",
  );
  ok(
    "donorPlatform still surfaced in breakdown",
    scored.scoreBreakdown?.donorPlatform === "GMT-K2XX",
  );
}

// ---------- 4. F-150 / Expedition sibling brake job -> Great Match ----------
{
  console.log("\n[4] F-150 / Expedition sibling brake job reaches Great Match");
  const target = {
    year: 2019,
    make: "Ford",
    model: "Expedition",
    engine: "3.5L EcoBoost V6",
    vin: null,
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-brake-f150",
    job: { title: "Front brake pads and rotors" },
    vehicle: { year: 2019, make: "Ford", model: "F-150", engine: "5.0L V8" },
    performedAt: "2026-03-01T00:00:00Z",
  };
  const scored = scoreJob(donor, target, lightGasSpecs, lightGasAltSpecs, "brake pads", {
    now: FIXED_NOW,
  });
  ok("vehicleSystem=brakes", scored.vehicleSystem === "brakes");
  ok("platformCreditApplied=true", scored.scoreBreakdown?.platformCreditApplied === true);
  ok(
    `score >= Great Match floor; got ${scored.matchScore}`,
    scored.matchScore >= SCORE_THRESHOLD_LIKELY,
  );
}

// ---------- 5. Unknown-platform vehicle preserves prior behavior ----------
{
  console.log("\n[5] Unknown-platform vehicle preserves prior behavior");
  // Mazda CX-5 has no entry in our table; donor is a different Mazda model.
  const target = {
    year: 2020,
    make: "Mazda",
    model: "CX-5",
    engine: "2.5L I4",
    vin: null,
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-mazda-1",
    job: { title: "Replace front control arm" },
    vehicle: { year: 2020, make: "Mazda", model: "CX-9", engine: "2.5L Turbo I4" },
  };
  const scored = scoreJob(donor, target, null, null, "control arm", { now: FIXED_NOW });
  ok("targetPlatform=null", scored.scoreBreakdown?.targetPlatform === null);
  ok("donorPlatform=null", scored.scoreBreakdown?.donorPlatform === null);
  ok("platformCreditApplied=false", scored.scoreBreakdown?.platformCreditApplied === false);
  ok(
    "reason does NOT mention platform",
    !/Same platform/.test(scored.matchReason),
    scored.matchReason,
  );
}

// ---------- 6. Cross-class GVWR still penalizes platform-sibling matches ----------
{
  console.log("\n[6] Cross-class GVWR still penalizes (safety preserved)");
  // Tahoe (light-duty SUV) target, donor is a Silverado 2500HD on a
  // different platform (HD trucks aren't K2XX SUVs). To exercise the same
  // *platform* + *cross-class* path more directly, use Suburban donor with
  // mismatched GVWR specs.
  const target = {
    year: 2018,
    make: "Chevrolet",
    model: "Tahoe",
    engine: "5.3L V8",
    vin: null,
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-cross-1",
    job: { title: "Front lower ball joint" },
    vehicle: { year: 2018, make: "Chevrolet", model: "Suburban", engine: "6.0L V8" },
  };
  const scored = scoreJob(donor, target, lightGasSpecs, heavyDieselSpecs, "ball joint", {
    now: FIXED_NOW,
  });
  ok("crossClassPenalized=true", scored.crossClassPenalized === true);
  ok("crossClassMultiplier=0.2", scored.scoreBreakdown?.crossClassMultiplier === 0.2);
  ok(
    "platform floor does NOT override cross-class penalty",
    scored.matchScore < SCORE_THRESHOLD_LIKELY,
    `got ${scored.matchScore}`,
  );
}

// ---------- 7. Same-model still outranks platform-sibling ----------
{
  console.log("\n[7] Same-model donor outranks platform-sibling donor");
  const target = {
    year: 2018,
    make: "Chevrolet",
    model: "Tahoe",
    engine: "5.3L V8",
    vin: null,
  };
  // Use a year gap and no extra evidence so neither donor saturates at 100,
  // exposing the modelScore (25) vs. platform-sibling (20) ranking gap.
  const sameModelDonor = {
    shopId: 99,
    workOrderId: "wo-tahoe-bj",
    job: { title: "Replace front lower ball joints" },
    vehicle: { year: 2015, make: "Chevrolet", model: "Tahoe", engine: "5.3L V8" },
  };
  const siblingDonor = {
    shopId: 99,
    workOrderId: "wo-sub-bj",
    job: { title: "Replace front lower ball joints" },
    vehicle: { year: 2015, make: "Chevrolet", model: "Suburban", engine: "5.3L V8" },
  };
  const sameModelScore = scoreJob(sameModelDonor, target, lightGasSpecs, lightGasSpecs, "ball joint", {
    now: FIXED_NOW,
  }).matchScore;
  const siblingScore = scoreJob(siblingDonor, target, lightGasSpecs, lightGasSpecs, "ball joint", {
    now: FIXED_NOW,
  }).matchScore;
  ok(
    `same-model score (${sameModelScore}) > sibling score (${siblingScore})`,
    sameModelScore > siblingScore,
  );
}

// ---------- 8. Different platform between sibling-make models -> no credit ----------
{
  console.log("\n[8] Different platform => no platform credit");
  // 2018 Tahoe (K2XX) target, donor is a 2022 Tahoe (T1XX) — same model so
  // same-model already wins; pick a more interesting case: 2018 Tahoe vs.
  // a Chevy Trax (different platform entirely, not in table).
  const target = {
    year: 2018,
    make: "Chevrolet",
    model: "Tahoe",
    engine: "5.3L V8",
    vin: null,
  };
  const donor = {
    shopId: 25,
    workOrderId: "wo-trax-bj",
    job: { title: "Replace front lower ball joints" },
    vehicle: { year: 2018, make: "Chevrolet", model: "Trax", engine: "1.4L Turbo I4" },
  };
  const scored = scoreJob(donor, target, lightGasSpecs, null, "ball joint", { now: FIXED_NOW });
  ok("platformCreditApplied=false", scored.scoreBreakdown?.platformCreditApplied === false);
  ok("targetPlatform=GMT-K2XX", scored.scoreBreakdown?.targetPlatform === "GMT-K2XX");
  ok("donorPlatform=null (Trax not in table)", scored.scoreBreakdown?.donorPlatform === null);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll Task #365 assertions passed.");
