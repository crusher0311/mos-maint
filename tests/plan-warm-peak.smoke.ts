/**
 * Task #1147 — peak-hours guard for the plan-warm cron.
 *
 * Verifies the pure policy in lib/plan-warm-peak.ts:
 *  - off-peak ticks run full budget
 *  - peak ticks default to throttle (concurrency 1, VIN cap min(offPeak, 10))
 *  - PLAN_WARM_PEAK_MODE=skip skips peak ticks, off disables the guard
 *  - midnight-wrapping windows and bad configs fail open (full budget)
 *  - missing RO mileage falls back to a cache-only estimate
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parsePeakHours, isPeakHourUtc, resolvePeakPolicy } from "../lib/plan-warm-peak";
import { selectPlanWarmCandidates } from "../lib/plan-warm-selection";
import { resolvePlanWarmMileage } from "../lib/plan-warm-mileage";
import {
  appendPlanBuildMileageMetadata,
  readPlanBuildMileageMetadata,
  signPlanBuildMileageMetadata,
  verifyPlanBuildMileageMetadataSignature,
} from "../lib/plan-build-mileage-metadata";

const caps = { maxVinsPerShop: 40, concurrency: 2 };
const at = (hourUtc: number) => new Date(Date.UTC(2026, 7, 25, hourUtc, 35, 0));

// parsePeakHours
assert.deepEqual(parsePeakHours(undefined), { start: 13, end: 23 }, "default window 13-23");
assert.deepEqual(parsePeakHours("22-4"), { start: 22, end: 4 }, "wrap window parses");
assert.equal(parsePeakHours("bogus"), null, "garbage → null");
assert.equal(parsePeakHours("5-5"), null, "empty window → null");
assert.equal(parsePeakHours("25-3"), null, "out-of-range → null");

// isPeakHourUtc
assert.equal(isPeakHourUtc(at(13), { start: 13, end: 23 }), true, "start inclusive");
assert.equal(isPeakHourUtc(at(23), { start: 13, end: 23 }), false, "end exclusive");
assert.equal(isPeakHourUtc(at(3), { start: 22, end: 4 }), true, "wrap: 3am in 22-4");
assert.equal(isPeakHourUtc(at(12), { start: 22, end: 4 }), false, "wrap: noon out");
assert.equal(isPeakHourUtc(at(13), null), false, "null window never peak");

// resolvePeakPolicy — default env
{
  const p = resolvePeakPolicy(at(4), caps, {});
  assert.deepEqual(p, { peak: false, action: "full", maxVinsPerShop: 40, concurrency: 2 }, "off-peak full");
}
{
  const p = resolvePeakPolicy(at(15), caps, {});
  assert.equal(p.action, "throttle", "peak defaults to throttle");
  assert.equal(p.concurrency, 1, "throttled concurrency 1");
  assert.equal(p.maxVinsPerShop, 10, "throttled VIN cap default 10");
}
// throttle never raises above the operator's off-peak cap
{
  const p = resolvePeakPolicy(at(15), { maxVinsPerShop: 5, concurrency: 2 }, {
    PLAN_WARM_PEAK_MAX_VINS_PER_SHOP: "25",
  });
  assert.equal(p.maxVinsPerShop, 5, "peak cap never exceeds off-peak cap");
}
// skip mode
{
  const p = resolvePeakPolicy(at(15), caps, { PLAN_WARM_PEAK_MODE: "skip" });
  assert.equal(p.action, "skip", "skip mode skips during peak");
  const q = resolvePeakPolicy(at(4), caps, { PLAN_WARM_PEAK_MODE: "skip" });
  assert.equal(q.action, "full", "skip mode still runs off-peak");
}
// off mode
{
  const p = resolvePeakPolicy(at(15), caps, { PLAN_WARM_PEAK_MODE: "off" });
  assert.equal(p.action, "full", "off disables the guard");
}
// bad window config fails open
{
  const p = resolvePeakPolicy(at(15), caps, { PLAN_WARM_PEAK_HOURS_UTC: "nope" });
  assert.equal(p.action, "full", "unparseable window → full budget");
}
// custom window + custom peak cap
{
  const p = resolvePeakPolicy(at(2), caps, {
    PLAN_WARM_PEAK_HOURS_UTC: "22-4",
    PLAN_WARM_PEAK_MAX_VINS_PER_SHOP: "3",
  });
  assert.equal(p.action, "throttle", "custom wrap window throttles");
  assert.equal(p.maxVinsPerShop, 3, "custom peak VIN cap");
}

// Repeated runs skip valid plans before applying the build cap, so a shop
// with more than 40 vehicles advances to the next batch.
async function verifyPlanWarmProgression() {
  const vehicles = Array.from({ length: 80 }, (_, index) => ({
    vin: `VIN-${String(index + 1).padStart(3, "0")}`,
    mileage: 10_000 + index,
  }));
  const cached = new Set<string>();
  let activeLookups = 0;
  let maxActiveLookups = 0;
  const isCached = async ({ vin }: { vin: string }) => {
    activeLookups++;
    maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
    await Promise.resolve();
    activeLookups--;
    return cached.has(vin);
  };

  const first = await selectPlanWarmCandidates({
    vehicles,
    maxCandidates: 40,
    concurrency: 2,
    isCached,
  });
  assert.deepEqual(
    first.pending.map(({ vin }) => vin),
    vehicles.slice(0, 40).map(({ vin }) => vin),
    "first run selects the first uncached batch",
  );
  first.pending.forEach(({ vin }) => cached.add(vin));

  const second = await selectPlanWarmCandidates({
    vehicles,
    maxCandidates: 40,
    concurrency: 2,
    isCached,
  });
  assert.equal(second.alreadyCached, 40, "second run skips the first valid batch");
  assert.deepEqual(
    second.pending.map(({ vin }) => vin),
    vehicles.slice(40, 80).map(({ vin }) => vin),
    "second run selects the next uncached batch",
  );
  assert.equal(second.pending.length, 40, "cache hits do not consume the build budget");
  assert.ok(maxActiveLookups <= 2, "cache selection respects the concurrency cap");
}

async function verifyMileageFallback() {
  let estimatorCalls = 0;
  const actual = await resolvePlanWarmMileage(
    42,
    "1HGCM82633A004352",
    48_210,
    async () => {
      estimatorCalls++;
      return { estimated: true, mileage: 60_000 };
    },
  );
  assert.deepEqual(
    actual,
    {
      mileage: 48_210,
      mileageSource: "actual",
      mileageEstimateDetails: null,
    },
    "uses actual RO mileage",
  );
  assert.equal(estimatorCalls, 0, "does not estimate when RO mileage exists");

  let estimatorArgs: [number, string] | null = null;
  let cacheHint: number | null | undefined;
  const selection = await selectPlanWarmCandidates({
    vehicles: [{ vin: "1HGCM82633A004352", mileage: null }],
    maxCandidates: 1,
    concurrency: 1,
    resolveMileage: async ({ vin, mileage }) =>
      resolvePlanWarmMileage(42, vin, mileage, async (shopId, estimatedVin) => {
          estimatorArgs = [shopId, estimatedVin];
          return {
            estimated: true,
            mileage: 73_125,
            confidence: "good",
            dataPoints: 3,
          };
        }),
    isCached: async ({ mileage }) => {
      cacheHint = mileage;
      return false;
    },
  });
  assert.equal(cacheHint, null, "cache lookup keeps the report's null mileage hint");
  assert.deepEqual(
    selection.pending,
    [{
      vin: "1HGCM82633A004352",
      mileage: 73_125,
      mileageSource: "estimated_carfax",
      mileageEstimateDetails: { confidence: "good", dataPoints: 3 },
    }],
    "missing RO mileage becomes a warm candidate",
  );
  assert.equal(selection.skippedNoMileage, 0, "estimated VIN is not skipped");
  assert.deepEqual(
    estimatorArgs,
    [42, "1HGCM82633A004352"],
    "estimates for the correct shop and VIN",
  );

  let cacheHitEstimatorCalls = 0;
  const cachedSelection = await selectPlanWarmCandidates({
    vehicles: [{ vin: "1HGCM82633A004352", mileage: null }],
    maxCandidates: 1,
    concurrency: 1,
    isCached: async ({ mileage }) => mileage === null,
    resolveMileage: async () => {
      cacheHitEstimatorCalls++;
      return {
        mileage: 90_000,
        mileageSource: "estimated_carfax",
        mileageEstimateDetails: null,
      };
    },
  });
  assert.equal(cachedSelection.alreadyCached, 1, "null-hint cache hit is reused");
  assert.equal(cachedSelection.pending.length, 0, "cached plan is not rebuilt");
  assert.equal(cacheHitEstimatorCalls, 0, "cache hit does not run the estimator");

  const params = new URLSearchParams();
  appendPlanBuildMileageMetadata(params, selection.pending[0]);
  const signatureContext = {
    shopId: 42,
    vin: "1HGCM82633A004352",
    mileage: 73_125,
  };
  const signature = signPlanBuildMileageMetadata(
    params,
    signatureContext,
    "unit-test-cron-secret",
  );
  assert.equal(
    verifyPlanBuildMileageMetadataSignature(
      signature,
      params,
      signatureContext,
      "unit-test-cron-secret",
    ),
    true,
    "valid internal metadata signature is accepted",
  );
  assert.equal(
    verifyPlanBuildMileageMetadataSignature(
      signature,
      params,
      { ...signatureContext, mileage: 73_126 },
      "unit-test-cron-secret",
    ),
    false,
    "signature cannot be replayed for different mileage",
  );
  assert.equal(
    verifyPlanBuildMileageMetadataSignature(
      signature,
      params,
      signatureContext,
      "wrong-secret",
    ),
    false,
    "forged internal metadata signature is rejected",
  );

  const metadata = readPlanBuildMileageMetadata(params, true);
  assert.deepEqual(
    metadata,
    {
      mileageSource: "estimated_carfax",
      mileageEstimateDetails: { confidence: "good", dataPoints: 3 },
    },
    "estimated source and details round-trip through the internal build request",
  );
  assert.deepEqual(
    readPlanBuildMileageMetadata(params, false),
    { mileageSource: "actual", mileageEstimateDetails: null },
    "untrusted callers cannot label mileage as estimated",
  );
  const planBuildRouteSource = readFileSync(
    "app/api/plan-build/route.ts",
    "utf8",
  );
  assert.match(
    planBuildRouteSource,
    /verifyPlanBuildMileageMetadataSignature\(/,
    "plan-build verifies mileage provenance with a dedicated signature",
  );
  assert.match(
    planBuildRouteSource,
    /\.\.\.mileageMetadata,\s*\n\s*deferredWork:/,
    "plan-build persists mileage provenance in the cached plan",
  );

  for (const estimate of [
    { estimated: false, mileage: null },
    { estimated: true, mileage: null },
    { estimated: true, mileage: 0 },
    { estimated: true, mileage: Number.NaN },
  ]) {
    const resolved = await resolvePlanWarmMileage(
      42,
      "1HGCM82633A004352",
      null,
      async () => estimate,
    );
    assert.equal(resolved, null, "rejects an unavailable or invalid estimate");
  }
}

Promise.all([verifyPlanWarmProgression(), verifyMileageFallback()])
  .then(() => console.log("plan-warm-peak smoke: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
