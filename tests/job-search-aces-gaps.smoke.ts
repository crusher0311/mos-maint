// tests/job-search-aces-gaps.smoke.ts
//
// Task #880 — Smoke test for the ACES exact-match gap fixes:
//   1. toVinSquish helper (pure squish from a raw VIN)
//   2. Same-squish tier → Exact Fit 95 (acesTier exact_aces), bypasses fuel gate
//   3. Candidate-set intersection → Likely Fit 90 (acesTier null)
//   4. Tier B fires when either vehicle_id is null (ambiguous squish)
//   5. "general" (unclassified) donors no longer earn Tier B
//   6. Classifier vocab additions (rotate / bulb / LOF / fuel induction)
//   7. specsFromStoredAces + resolveJobSearchSpecs (stored-first, injected decode)
// Pure unit-style: no DB / network access.

import {
  scoreJob,
  SCORE_ACES_EXACT,
  SCORE_HEURISTIC_EXACT_CAP,
  SCORE_THRESHOLD_EXACT,
  classifyVehicleSystem,
  extractVehicleSpecs,
  type VehicleSpecs,
} from "@/lib/job-scoring";
import { toVinSquish } from "@/lib/aces-fields";
import { specsFromStoredAces, resolveJobSearchSpecs } from "@/lib/job-search-specs";

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
    gvwrBand: "passenger",
    bodyType: "sedan",
    driveType: "fwd",
    displacement: "2.0",
    fuelType: "gasoline",
    acesVehicleId: null,
    acesEngineId: null,
    submodelKey: null,
    candidateVehicleIds: null,
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

// -- 1. toVinSquish ----------------------------------------------------------
{
  // Squish = positions 1-8 + 10-11 (skip the check digit at position 9).
  if (toVinSquish("1HGCM82633A123456") !== "1HGCM8263A") fail(`toVinSquish full VIN: got ${toVinSquish("1HGCM82633A123456")}`);
  if (toVinSquish(" 1hgcm82633a123456 ") !== "1HGCM8263A") fail("toVinSquish must trim + uppercase");
  if (toVinSquish("1HGCM8263") !== null) fail("toVinSquish must reject <11 chars");
  if (toVinSquish("1HGCM8263IA123456") !== null) fail("toVinSquish must reject I/O/Q charset");
  if (toVinSquish(null) !== null || toVinSquish(undefined) !== null || toVinSquish(123 as any) !== null) {
    fail("toVinSquish must return null for non-strings");
  }
  ok("toVinSquish extracts positions 1-8 + 10-11, rejects short/invalid VINs");
}

// -- 2. Same-squish tier → Exact Fit 95, even with null ACES ids & fuel noise -
{
  // Donor VIN differs only in the sequential section (positions 12-17) and the
  // check digit — same squish. Both sides have NO ACES ids (ambiguous squish).
  const donorVin = "1HGCM82633A999999";
  if (toVinSquish(donorVin) !== toVinSquish(baseTargetVehicle.vin)) fail("fixture error: squishes should match");
  const t = specs({ fuelType: "gasoline" });
  const j = specs({ fuelType: "diesel" }); // free-text fuel noise must not gate
  const r = scoreJob(
    donorJob({ vehicle: { vin: donorVin, year: 2018, make: "Honda", model: "Accord" }, title: "Oil Change", job: { title: "Oil Change" } }),
    baseTargetVehicle,
    t,
    j,
    "oil change",
  );
  if (r.matchScore !== SCORE_ACES_EXACT) fail(`Same-squish expected ${SCORE_ACES_EXACT}, got ${r.matchScore}`);
  if (r.matchBand !== "exact") fail(`Same-squish expected band exact, got ${r.matchBand}`);
  if (r.matchBandLabel !== "Exact Fit") fail(`Same-squish expected "Exact Fit", got ${r.matchBandLabel}`);
  if ((r.scoreBreakdown as any).acesTier !== "exact_aces") fail(`Same-squish acesTier: ${(r.scoreBreakdown as any).acesTier}`);
  if (r.gatePass !== true) fail("Same-squish must bypass fuel gate");
  ok("Same-squish donor scores Exact Fit 95 (exact_aces) and bypasses the fuel gate");
}

// -- 2b. Same-VIN still outranks same-squish (100 vs 95) ---------------------
{
  const r = scoreJob(
    donorJob({ vehicle: { vin: baseTargetVehicle.vin, year: 2018, make: "Honda", model: "Accord" } }),
    baseTargetVehicle,
    specs({}),
    specs({}),
    "brake pad",
  );
  if (r.matchScore !== 100) fail(`Same-VIN expected 100, got ${r.matchScore}`);
  if (!r.sameVinFastPath) fail("Same-VIN must use the VIN fast path, not the squish tier");
  ok("Same-VIN fast path still returns 100 and outranks same-squish 95");
}

// -- 3. Candidate-set intersection → Likely Fit 90, acesTier null ------------
{
  // Target resolved concrete vid 1234; donor squish ambiguous with candidates
  // [1234, 5678] — donor MAY be the same build, but not confirmed.
  const t = specs({ acesVehicleId: 1234, acesEngineId: 555 });
  const j = specs({ acesVehicleId: null, acesEngineId: null, candidateVehicleIds: [1234, 5678] });
  const r = scoreJob(donorJob(), baseTargetVehicle, t, j, "brake pad");
  if (r.matchScore !== SCORE_HEURISTIC_EXACT_CAP) fail(`Candidate intersection expected ${SCORE_HEURISTIC_EXACT_CAP}, got ${r.matchScore}`);
  if (r.matchBandLabel !== "Likely Fit") fail(`Candidate intersection expected "Likely Fit", got ${r.matchBandLabel}`);
  if ((r.scoreBreakdown as any).acesTier !== null) fail(`Candidate intersection acesTier must be null, got ${(r.scoreBreakdown as any).acesTier}`);
  ok("Concrete-vid ∩ candidate-set donor scores Likely Fit 90 with acesTier null");

  // Both ambiguous, sets overlap.
  const t2 = specs({ candidateVehicleIds: [10, 20] });
  const j2 = specs({ candidateVehicleIds: [20, 30] });
  const r2 = scoreJob(donorJob(), baseTargetVehicle, t2, j2, "brake pad");
  if (r2.matchScore !== SCORE_HEURISTIC_EXACT_CAP || r2.matchBandLabel !== "Likely Fit") {
    fail(`Set∩set expected Likely Fit 90, got ${r2.matchScore} / ${r2.matchBandLabel}`);
  }
  ok("Overlapping candidate sets on both sides score Likely Fit 90");

  // Disjoint sets must fall through to the heuristic (no tier).
  const t3 = specs({ candidateVehicleIds: [10, 20] });
  const j3 = specs({ candidateVehicleIds: [30, 40] });
  const r3 = scoreJob(donorJob(), baseTargetVehicle, t3, j3, "brake pad");
  if (r3.matchScore === SCORE_HEURISTIC_EXACT_CAP && r3.matchBandLabel === "Likely Fit" && (r3.scoreBreakdown as any).evidenceBonus === 0 && (r3.scoreBreakdown as any).model === 0) {
    fail("Disjoint candidate sets must not fire the intersection tier");
  }
  ok("Disjoint candidate sets fall through to the heuristic scorer");
}

// -- 4. Tier B fires with a null vehicle_id on either side -------------------
{
  const t = specs({ acesVehicleId: null, acesEngineId: 999 }); // ambiguous squish, concrete engine
  const j = specs({ acesVehicleId: 2, acesEngineId: 999 });
  const r = scoreJob(donorJob({ title: "Oil Change", job: { title: "Oil Change" } }), baseTargetVehicle, t, j, "oil change");
  if ((r.scoreBreakdown as any).acesTier !== "engine_match") fail(`Tier B w/ null vid: acesTier ${(r.scoreBreakdown as any).acesTier}`);
  if (r.matchScore >= SCORE_THRESHOLD_EXACT) fail(`Tier B must stay below exact threshold, got ${r.matchScore}`);
  ok("Tier B (engine_match) fires when one side's vehicle_id is null");
}

// -- 5. Unclassified ("general") donors no longer earn Tier B ----------------
{
  const t = specs({ acesVehicleId: 1, acesEngineId: 999 });
  const j = specs({ acesVehicleId: 2, acesEngineId: 999 });
  const title = "Customer states check it over"; // classifies as general
  if (classifyVehicleSystem(title, []) !== "general") fail("fixture error: title should classify as general");
  const r = scoreJob(donorJob({ title, job: { title } }), baseTargetVehicle, t, j, "check over");
  if ((r.scoreBreakdown as any).acesTier === "engine_match") {
    fail("Unclassified (general) donor must NOT earn Tier B engine_match");
  }
  ok("Unclassified (general) donors no longer earn the Tier B engine boost");
}

// -- 6. Classifier vocab additions -------------------------------------------
{
  const cases: Array<[string, string]> = [
    ["Rotate tires", "wheel_tire"],
    ["Flat repair LR", "wheel_tire"],
    ["Patch & plug tire", "wheel_tire"],
    ["Replace light bulb", "body"],
    ["License plate lamp", "body"],
    ["LOF", "powertrain"],
    ["Lube, oil and filter", "powertrain"],
    ["Fuel induction service", "powertrain"],
    ["Fuel system cleaning", "powertrain"],
  ];
  for (const [title, expected] of cases) {
    const got = classifyVehicleSystem(title, []);
    if (got !== expected) fail(`classifyVehicleSystem("${title}") expected ${expected}, got ${got}`);
  }
  ok("Classifier vocab additions (rotate/flat repair/bulb/lamp/LOF/fuel induction) bucket correctly");
}

// -- 7a. specsFromStoredAces ---------------------------------------------------
{
  const s = specsFromStoredAces({ acesVehicleId: "1234", acesEngineId: 555, submodelKey: "2018|honda|accord" });
  if (!s || s.acesVehicleId !== 1234 || s.acesEngineId !== 555 || s.submodelKey !== "2018|honda|accord") {
    fail(`specsFromStoredAces mis-read stored IDs: ${JSON.stringify(s)}`);
  }
  if (specsFromStoredAces({ vin: "X", year: 2018 }) !== null) fail("specsFromStoredAces must return null with no ACES fields");
  if (specsFromStoredAces(null) !== null) fail("specsFromStoredAces(null) must be null");
  ok("specsFromStoredAces reads stored IDs (coerced) and returns null when absent");
}

// -- 7b. resolveJobSearchSpecs — stored-first, live decode only for the rest --
// (async section wrapped so the file runs under CJS-transpiled tsx too)
async function asyncSections(): Promise<void> {
  const targetVin = "1HGCM82633A123456";
  const storedJob = { _id: "a", vehicle: { vin: "3FADP4EJ2DM111111", acesVehicleId: 77, acesEngineId: 88 } };
  const bareJob = { _id: "b", vehicle: { vin: "2HGCM82633A999999" } };
  const shortVinJob = { _id: "c", vehicle: { vin: "SHORT" } };
  const decodedRow = { vehicle_id: 42, engine_id: 9, year: 2018, make: "HONDA", model: "ACCORD" };

  const decodedCalls: string[][] = [];
  const res = await resolveJobSearchSpecs({
    targetVin,
    jobs: [storedJob, bareJob, shortVinJob],
    idFor: (j: any) => j._id,
    toSquish: (vin: string) => {
      const sq = toVinSquish(vin);
      if (!sq) throw new Error("bad vin");
      return sq;
    },
    batchDecode: async (squishes: string[]) => {
      decodedCalls.push(squishes);
      const m = new Map<string, any>();
      for (const sq of squishes) m.set(sq, decodedRow);
      return m;
    },
  });

  if (decodedCalls.length !== 1) fail("batchDecode should be called exactly once");
  const asked = decodedCalls[0];
  if (asked.includes(toVinSquish("3FADP4EJ2DM111111")!)) fail("stored-ID donor must NOT be live-decoded");
  if (!asked.includes(toVinSquish(targetVin)!)) fail("target VIN must be live-decoded");
  if (!asked.includes(toVinSquish("2HGCM82633A999999")!)) fail("bare donor must be live-decoded");
  if (!res.targetSpecs || res.targetSpecs.acesVehicleId !== 42) fail("target specs must come from the live decode");
  const aSpecs = res.jobSpecsMap.get("a");
  if (!aSpecs || aSpecs.acesVehicleId !== 77 || aSpecs.acesEngineId !== 88) fail("stored donor must use stored IDs");
  const bSpecs = res.jobSpecsMap.get("b");
  if (!bSpecs || bSpecs.acesVehicleId !== 42) fail("bare donor must use the live decode");
  if (res.jobSpecsMap.has("c")) fail("short-VIN donor must have no specs");
  if (res.storedCount !== 1 || res.liveCount !== 1) fail(`counts: stored=${res.storedCount} live=${res.liveCount}`);
  ok("resolveJobSearchSpecs uses stored IDs first and live-decodes only target + uncovered donors");

  // Decode throwing must not throw out of the resolver — stored specs survive.
  const res2 = await resolveJobSearchSpecs({
    targetVin,
    jobs: [storedJob, bareJob],
    idFor: (j: any) => j._id,
    toSquish: (vin: string) => toVinSquish(vin)!,
    batchDecode: async () => { throw new Error("dataone down"); },
  });
  if (!res2.jobSpecsMap.has("a")) fail("stored specs must survive a decode failure");
  if (res2.targetSpecs !== null) fail("target specs must be null when decode fails");
  ok("resolveJobSearchSpecs degrades gracefully when the live decode fails");
}

// -- 7c. extractVehicleSpecs picks up candidate_vehicle_ids -------------------
{
  const s = extractVehicleSpecs({
    vehicle_id: null,
    engine_id: 9,
    year: 2018,
    make: "HONDA",
    model: "ACCORD",
    candidate_vehicle_ids: [11, 22, 0, -1],
  } as any);
  if (!s.candidateVehicleIds || s.candidateVehicleIds.join(",") !== "11,22") {
    fail(`extractVehicleSpecs candidateVehicleIds: ${JSON.stringify(s.candidateVehicleIds)}`);
  }
  const s2 = extractVehicleSpecs({ vehicle_id: 5, engine_id: 9, year: 2018, make: "H", model: "A" } as any);
  if (s2.candidateVehicleIds !== null) fail("candidateVehicleIds must be null when absent");
  ok("extractVehicleSpecs surfaces candidate_vehicle_ids (filtered to positive numbers)");
}

asyncSections()
  .then(() => {
    console.log("\nALL TASK #880 ACES GAP SMOKE TESTS PASSED");
    process.exit(0);
  })
  .catch((err) => {
    console.error("✗ async sections threw:", err);
    process.exit(1);
  });
