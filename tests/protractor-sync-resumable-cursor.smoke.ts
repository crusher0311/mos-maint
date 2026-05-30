/**
 * Smoke test for the Protractor daily-sync resumable-sweep cursor
 * (`computeSweepPlan` in `lib/integrations/protractor/sync-cursor.ts`).
 *
 * Regression target: the cron used to refresh ALL Protractor shops every run,
 * which consistently hit the scheduler's 25-min hard abort — the run never
 * recorded a success (`lastSuccessByJob` stuck at NEVER) and shops late in the
 * pLimit(4) queue never refreshed, staling dashboards fleet-wide. The cron now
 * sweeps shops in rotating batches across runs using this cursor: each run
 * works the shops not yet done this cycle, marks each completed shop done, and
 * the next run continues. When all shops are done the cycle resets.
 *
 * This locks in the pure cursor math:
 *   1. A fresh progress doc (no done shops) sweeps every shop.
 *   2. Partial progress sweeps only the not-yet-done shops (forward progress).
 *   3. A complete cycle RESETS and starts a fresh full sweep.
 *   4. Shops removed from config are dropped from the done set (no phantom ids).
 *   5. A newly-added shop is treated as remaining within the current cycle.
 *   6. Empty fleet is a no-op (no spurious reset).
 *   7. A shop that exhausts its attempts is skipped (not in remaining).
 *   8. A pathological shop alone cannot block the cycle reset — once every
 *      other shop is done and it is exhausted, the cycle resets (the core
 *      forward-progress guarantee).
 *   9. Exhaustion is per-cycle: a reset clears the exhausted list so the shop
 *      gets a fresh chance next cycle.
 */

import assert from "node:assert";
import { computeSweepPlan } from "../lib/integrations/protractor/sync-cursor";

// 1. Fresh start — nothing done yet → sweep everything, no reset.
{
  const all = [25, 29, 35, 66];
  const plan = computeSweepPlan(all, []);
  assert.strictEqual(plan.cycleReset, false, "fresh start should not be a reset");
  assert.deepStrictEqual(plan.doneShopIds, [], "nothing done yet");
  assert.deepStrictEqual(plan.remainingShopIds, all, "all shops remain");
}

// 2. Partial progress — only the not-yet-done shops remain.
{
  const all = [25, 29, 35, 66];
  const plan = computeSweepPlan(all, [25, 29]);
  assert.strictEqual(plan.cycleReset, false, "partial progress is not a reset");
  assert.deepStrictEqual(plan.remainingShopIds, [35, 66], "only undone shops remain");
}

// 3. Complete cycle — every shop done → reset and sweep all again.
{
  const all = [25, 29, 35, 66];
  const plan = computeSweepPlan(all, [25, 29, 35, 66]);
  assert.strictEqual(plan.cycleReset, true, "completed cycle should reset");
  assert.deepStrictEqual(plan.doneShopIds, [], "reset clears the done set");
  assert.deepStrictEqual(plan.remainingShopIds, all, "fresh sweep covers all shops");
}

// 4. A shop was removed from config — its id is dropped from done, no phantom.
{
  const all = [25, 29]; // shop 35 removed since last run
  const plan = computeSweepPlan(all, [25, 35]);
  assert.strictEqual(plan.cycleReset, false);
  // 25 is done; 35 no longer configured → ignored; 29 remains.
  assert.deepStrictEqual(plan.remainingShopIds, [29], "removed shop ignored, 29 remains");
}

// 5. A new shop appeared mid-cycle — it is remaining, not falsely complete.
{
  const all = [25, 29, 99]; // 99 just onboarded
  const plan = computeSweepPlan(all, [25, 29]);
  assert.strictEqual(plan.cycleReset, false, "a new shop means the cycle is not complete");
  assert.deepStrictEqual(plan.remainingShopIds, [99], "new shop is swept this cycle");
}

// 6. Empty fleet — no shops, no reset, nothing to do.
{
  const plan = computeSweepPlan([], []);
  assert.strictEqual(plan.cycleReset, false, "empty fleet must not spuriously reset");
  assert.deepStrictEqual(plan.remainingShopIds, []);
}

// 7. A shop that hit the attempt cap is exhausted — skipped, not in remaining.
{
  const all = [25, 29, 35, 66];
  // Shop 35 has been attempted 3 times this cycle without completing.
  const plan = computeSweepPlan(all, [25, 29], { "35": 3 });
  assert.strictEqual(plan.cycleReset, false, "cycle not complete — 66 still pending");
  assert.deepStrictEqual(plan.exhaustedShopIds, [35], "shop 35 is exhausted");
  assert.deepStrictEqual(
    plan.remainingShopIds,
    [66],
    "exhausted shop is skipped; only the genuinely-pending shop remains"
  );
}

// 8. Forward-progress guarantee: one pathological shop alone cannot block the
//    cycle. Every other shop done + the fat shop exhausted → cycle resets.
{
  const all = [25, 29, 35, 66];
  const plan = computeSweepPlan(all, [25, 29, 66], { "35": 3 });
  assert.strictEqual(
    plan.cycleReset,
    true,
    "all-done-or-exhausted must reset so the fleet keeps refreshing"
  );
  assert.deepStrictEqual(plan.doneShopIds, [], "reset clears the done set");
  assert.deepStrictEqual(plan.exhaustedShopIds, [], "reset clears the exhausted set");
  assert.deepStrictEqual(plan.remainingShopIds, all, "fresh sweep covers all shops again");
}

// 9. A shop just under the cap is NOT exhausted — it still gets retried.
{
  const all = [25, 35];
  const plan = computeSweepPlan(all, [25], { "35": 2 }); // cap is 3
  assert.strictEqual(plan.cycleReset, false);
  assert.deepStrictEqual(plan.exhaustedShopIds, [], "2 attempts < cap → not exhausted");
  assert.deepStrictEqual(plan.remainingShopIds, [35], "shop 35 still gets retried");
}

console.log("✓ protractor-sync resumable-cursor smoke test passed");
