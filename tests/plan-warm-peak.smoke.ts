/**
 * Task #1147 — peak-hours guard for the plan-warm cron.
 *
 * Verifies the pure policy in lib/plan-warm-peak.ts:
 *  - off-peak ticks run full budget
 *  - peak ticks default to throttle (concurrency 1, VIN cap min(offPeak, 10))
 *  - PLAN_WARM_PEAK_MODE=skip skips peak ticks, off disables the guard
 *  - midnight-wrapping windows and bad configs fail open (full budget)
 */
import assert from "node:assert";
import { parsePeakHours, isPeakHourUtc, resolvePeakPolicy } from "../lib/plan-warm-peak";

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

console.log("plan-warm-peak smoke: all assertions passed");
