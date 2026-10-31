import test from "node:test";
import assert from "node:assert/strict";
import { createTirePilotManualBudget } from "../lib/tire-dot-manual-budget";

test("daytime allowance requires explicit opt-in and expires without fallback", () => {
  let time = new Date("2026-10-31T15:00:00Z");
  assert.equal(createTirePilotManualBudget([], () => time), undefined);
  const budget = createTirePilotManualBudget(["--daytime-once"], () => time)!;
  assert.equal(budget.available(), true);
  time = new Date("2026-10-31T15:15:00Z");
  assert.equal(budget.available(), false);
  assert.throws(() => budget.admit(), /window_manual_limit/);
  assert.equal(budget.requests, 0);
});
test("daytime allowance counts attempts and stops at twenty", () => {
  const budget = createTirePilotManualBudget(["--daytime-once"], () => new Date("2026-10-31T15:00:00Z"))!;
  for (let n = 0; n < 20; n++) budget.admit();
  assert.equal(budget.requests, 20);
  assert.equal(budget.available(), false);
  assert.throws(() => budget.admit(), /window_manual_limit/);
});
