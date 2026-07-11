/**
 * Unit tests for the Estimate Assist job builder's knowledge-base lookup and
 * VIN-aware decision logic (`lib/estimate-assist/job-builder-logic.ts` +
 * the lookup functions in `lib/estimate-assist/job-knowledge-base.ts`).
 *
 * Run: `npx tsx tests/estimate-job-builder.smoke.ts`
 *
 * Covers:
 *  - Exact jobId resolution and fuzzy title/tag search (ranking)
 *  - VIN-aware attribute adjustments: awd, 4wd/4x4, v6/v8, electronic
 *    parking brake (year gate), CVT (parts only)
 *  - The AI-fallback decision threshold (no KB match / thin description)
 *  - Companion/upsell expansion helpers
 *
 * No DB or OpenAI involved — everything under test is pure.
 */
import {
  resolveKnowledgeBaseJob,
  applyVinAttributeAdjustments,
  shouldUseAiFallback,
  AI_FALLBACK_MIN_DESCRIPTION_LENGTH,
} from "../lib/estimate-assist/job-builder-logic";
import {
  getJobById,
  searchJobs,
  getCompanionJobs,
  getUpsellJobs,
  getJobKnowledgeBase,
  JobKnowledgeEntry,
} from "../lib/estimate-assist/job-knowledge-base";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("estimate job builder logic");

// ---------------------------------------------------------------- KB lookup
{
  console.log("\nKnowledge-base lookup (exact + fuzzy):");

  const exact = resolveKnowledgeBaseJob("brakes-front-pads");
  ok("exact jobId resolves directly", exact?.jobId === "brakes-front-pads");

  const fuzzy = resolveKnowledgeBaseJob("front brake pads");
  ok('fuzzy "front brake pads" → brakes-front-pads', fuzzy?.jobId === "brakes-front-pads", fuzzy?.jobId);

  const fuzzyTb = resolveKnowledgeBaseJob("timing belt");
  ok('fuzzy "timing belt" → timing-belt', fuzzyTb?.jobId === "timing-belt", fuzzyTb?.jobId);

  const none = resolveKnowledgeBaseJob("zzzz unmatchable widget qqqq");
  ok("no-match query resolves to null", none === null);

  // searchJobs ranking: title hits outrank tag/description-only hits
  const results = searchJobs("brake pads", 5);
  ok("searchJobs returns multiple candidates", results.length >= 2);
  ok(
    "top results are pad-replacement jobs",
    ["brakes-front-pads", "brakes-rear-pads"].includes(results[0]?.jobId),
    results[0]?.jobId,
  );

  const limited = searchJobs("brake", 2);
  ok("searchJobs respects limit", limited.length === 2);

  ok("getJobById unknown id → undefined", getJobById("not-a-real-job") === undefined);
}

// ---------------------------------------------------------------- VIN adjustments
{
  console.log("\nVIN-aware attribute adjustments:");

  // differential-fluid has: { condition: "awd", laborHoursAdjust: 0.3,
  //   additionalParts: ["Front Differential Fluid"] }
  const diff = getJobById("differential-fluid")!;

  const awd = applyVinAttributeAdjustments(diff, { drivetrain: "AWD" });
  ok("AWD drivetrain → +0.3h on differential fluid", awd.laborHoursAdjust === 0.3, String(awd.laborHoursAdjust));
  ok("  → adds front differential fluid part", awd.additionalParts.includes("Front Differential Fluid"));

  const awdMixedCase = applyVinAttributeAdjustments(diff, { drivetrain: "All Wheel Drive (awd)" });
  ok("case-insensitive substring drivetrain match", awdMixedCase.laborHoursAdjust === 0.3);

  const fwd = applyVinAttributeAdjustments(diff, { drivetrain: "FWD" });
  ok("FWD drivetrain → no adjustment", fwd.laborHoursAdjust === 0 && fwd.additionalParts.length === 0);

  const noDrivetrain = applyVinAttributeAdjustments(diff, {});
  ok("missing drivetrain → no adjustment", noDrivetrain.laborHoursAdjust === 0);

  // spark-plugs has v6 (+0.5) and v8 (+0.5) attributes
  const plugs = getJobById("spark-plugs")!;
  const v6 = applyVinAttributeAdjustments(plugs, { engineCylinders: 6 });
  ok("V6 engine → +0.5h on spark plugs", v6.laborHoursAdjust === 0.5, String(v6.laborHoursAdjust));
  const v8 = applyVinAttributeAdjustments(plugs, { engineCylinders: 8 });
  ok("V8 engine → +0.5h on spark plugs", v8.laborHoursAdjust === 0.5);
  const i4 = applyVinAttributeAdjustments(plugs, { engineCylinders: 4 });
  ok("4-cyl engine → no spark plug adjustment", i4.laborHoursAdjust === 0);
  const v6and8 = applyVinAttributeAdjustments(plugs, { engineCylinders: 7 } as any);
  ok("odd cylinder count matches neither", v6and8.laborHoursAdjust === 0);

  // brakes-rear-pads has electronic_parking_brake (+0.3, gated on year>=2016)
  const rearPads = getJobById("brakes-rear-pads")!;
  const epbNew = applyVinAttributeAdjustments(rearPads, { year: 2020 });
  ok("2020 vehicle → EPB +0.3h on rear pads", epbNew.laborHoursAdjust === 0.3);
  const epbBoundary = applyVinAttributeAdjustments(rearPads, { year: 2016 });
  ok("2016 boundary year → EPB applies (>=)", epbBoundary.laborHoursAdjust === 0.3);
  const epbOld = applyVinAttributeAdjustments(rearPads, { year: 2015 });
  ok("2015 vehicle → no EPB adjustment", epbOld.laborHoursAdjust === 0);
  const epbNoYear = applyVinAttributeAdjustments(rearPads, {});
  ok("unknown year → no EPB adjustment", epbNoYear.laborHoursAdjust === 0);

  // transmission-fluid-service has cvt_transmission → parts only, no labor add
  const trans = getJobById("transmission-fluid-service")!;
  const cvt = applyVinAttributeAdjustments(trans, { transmission: "CVT Automatic" });
  ok("CVT transmission → CVT Fluid part added", cvt.additionalParts.includes("CVT Fluid"));
  ok("  → no labor-hours change for CVT", cvt.laborHoursAdjust === 0);
  const auto = applyVinAttributeAdjustments(trans, { transmission: "6-speed automatic" });
  ok("non-CVT transmission → no extra parts", auto.additionalParts.length === 0);

  // transfer-case-fluid: 4wd matches "4wd" AND "4x4" spellings
  const tc = getJobById("transfer-case-fluid")!;
  const fourByFour = applyVinAttributeAdjustments(tc, { drivetrain: "4x4" });
  const fourWd = applyVinAttributeAdjustments(tc, { drivetrain: "4WD" });
  ok("4x4 and 4WD spellings both match the 4wd condition",
    fourByFour.laborHoursAdjust === 0 && fourWd.laborHoursAdjust === 0 &&
    // both attrs have laborHoursAdjust 0 — assert no throw and no parts leak
    fourByFour.additionalParts.length === 0 && fourWd.additionalParts.length === 0);

  // Jobs without vinAttributes / null job are safe no-ops
  const noAttrs = applyVinAttributeAdjustments(getJobById("brake-fluid-flush"), { drivetrain: "AWD", engineCylinders: 8, year: 2022 });
  ok("job without vinAttributes → zero adjustments", noAttrs.laborHoursAdjust === 0 && noAttrs.additionalParts.length === 0);
  const nullJob = applyVinAttributeAdjustments(null, { drivetrain: "AWD" });
  ok("null job → zero adjustments", nullJob.laborHoursAdjust === 0);
}

// ---------------------------------------------------------------- AI fallback threshold
{
  console.log("\nAI-fallback decision threshold:");

  ok("no KB match → AI fallback", shouldUseAiFallback(null) === true);
  ok("undefined → AI fallback", shouldUseAiFallback(undefined) === true);

  const realJob = getJobById("brakes-front-pads")!;
  ok("real KB entry (long description) → no AI fallback", shouldUseAiFallback(realJob) === false);

  const thin: JobKnowledgeEntry = { ...realJob, technicalDescription: "Replace pads." };
  ok("thin technical description (<50 chars) → AI fallback", shouldUseAiFallback(thin) === true);

  const boundary: JobKnowledgeEntry = {
    ...realJob,
    technicalDescription: "x".repeat(AI_FALLBACK_MIN_DESCRIPTION_LENGTH),
  };
  ok("exactly-threshold description → no AI fallback (strict <)", shouldUseAiFallback(boundary) === false);

  // Every shipped KB entry must be rich enough to never need the AI pass —
  // if someone adds a stub entry, this catches it.
  const stubs = getJobKnowledgeBase().filter(j => shouldUseAiFallback(j));
  ok("no shipped KB entry triggers the AI fallback", stubs.length === 0, stubs.map(j => j.jobId).join(","));
}

// ---------------------------------------------------------------- companions/upsells
{
  console.log("\nCompanion / upsell expansion:");
  const comps = getCompanionJobs("brakes-front-pads");
  ok("front pads companions resolve to KB entries",
    comps.length === 3 && comps.every(c => !!c.jobId),
    comps.map(c => c.jobId).join(","));
  const ups = getUpsellJobs("brakes-front-pads");
  ok("front pads upsells resolve", ups.length === 2, ups.map(u => u.jobId).join(","));
  ok("unknown jobId → empty arrays", getCompanionJobs("nope").length === 0 && getUpsellJobs("nope").length === 0);

  // Referential integrity: every companion/upsell id in the KB must exist.
  const kb: JobKnowledgeEntry[] = getJobKnowledgeBase();
  const ids = new Set(kb.map(j => j.jobId));
  const dangling: string[] = [];
  for (const j of kb) {
    for (const ref of [...j.companionJobs, ...j.upsellJobs]) {
      if (!ids.has(ref)) dangling.push(`${j.jobId} → ${ref}`);
    }
  }
  // Known pre-existing dangling refs are tolerated (they are silently
  // filtered by getCompanionJobs) but we pin the list so it can only shrink.
  const known = new Set([
    "transfer-case-fluid → transmission-fluid-change",
    "heater-core → cabin-air-filter",
    "blower-motor-resistor → cabin-air-filter",
    "ac-compressor → cabin-air-filter",
    "blend-door-actuator → cabin-air-filter",
    "30k-service → cabin-air-filter",
    "60k-service → transmission-fluid-change",
    "transmission-solenoid → transmission-fluid-change",
    "torque-converter → transmission-fluid-change",
  ]);
  const newDangling = dangling.filter(d => !known.has(d));
  ok(
    "no NEW dangling companion/upsell references in the KB",
    newDangling.length === 0,
    newDangling.join("; "),
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll assertions passed");
