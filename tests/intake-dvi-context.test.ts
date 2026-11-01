import test from "node:test";
import assert from "node:assert/strict";
import {createIntakeContextReader, projectIntakeContext, intakeContextSchema} from "../lib/auto-dvi/staff/intake-context";
import type {CachedPlan} from "../lib/plan-cache";

test("missing context never becomes a score or satisfactory finding", () => {
  assert.deepEqual(projectIntakeContext(null), {status: "missing", coverage: "unknown", checks: []});
  assert.equal(intakeContextSchema.safeParse({vin: "invalid", mileage: 100, distanceUnit: "miles"}).success, false);
});
test("projection is bounded and strips ratings, private history and scores", () => {
  const cached = {plan: {score: 100, customerName: "private", buckets: {
    overdue: Array.from({length: 50}, () => ({title: "Check tires", rating: "red", private: "secret"})), dueSoon: [],
  }}} as unknown as CachedPlan;
  const result = projectIntakeContext(cached);
  assert.equal(result.coverage, "unknown");
  assert.equal(result.checks.length, 20);
  assert.deepEqual(Object.keys(result.checks[0]).sort(), ["timing", "title"]);
  assert.equal(JSON.stringify(result).includes("private"), false);
});
test("timeout retains concurrency slot until underlying read settles", async () => {
  const read = createIntakeContextReader(1, 5);
  let resolve!: (value: CachedPlan | null) => void;
  const pending = new Promise<CachedPlan | null>(r => {resolve = r;});
  assert.equal((await read(() => pending)).status, "unavailable");
  let called = false;
  assert.equal((await read(async () => {called = true; return null;})).status, "unavailable");
  assert.equal(called, false);
  resolve(null);
  await new Promise(r => setTimeout(r, 0));
  assert.equal((await read(async () => null)).status, "missing");
  assert.equal((await read(async () => {throw Error("DB unavailable");})).status, "unavailable");
});
