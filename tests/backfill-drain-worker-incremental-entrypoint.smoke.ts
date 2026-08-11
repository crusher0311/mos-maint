/**
 * Smoke test: the DEPLOYED worker entrypoint starts the Tekmetric
 * incremental-sync loop when TEKMETRIC_INCREMENTAL_ON_WORKER=true.
 *
 * Run: `npx tsx tests/backfill-drain-worker-incremental-entrypoint.smoke.ts`
 *
 * Regression target: the worker-lane flag suppresses EVERY web invocation
 * path of the incremental sync (scheduler registration, daily-all, the
 * route itself). If the production background worker service —
 * `npm run worker:backfill-drain` → scripts/backfill-drain-worker.ts —
 * did not start a replacement cycle, flipping the flag would silently
 * halt incremental sync fleet-wide. This pins that the deployed
 * entrypoint's startup path actually starts the loop under the flag.
 */

import assert from "node:assert/strict";

async function main() {
  console.log("backfill-drain-worker incremental entrypoint smoke:");

  // Importing the entrypoint module must NOT auto-run the drain loops
  // (guarded by the direct-run check) — if it did, this test would spawn
  // real drain children.
  const mod = await import("../scripts/backfill-drain-worker");
  assert.equal(typeof mod.maybeStartIncrementalLoop, "function");
  console.log("  ✓ entrypoint module imports without auto-running drain loops");

  // Flag off → no loop.
  delete process.env.TEKMETRIC_INCREMENTAL_ON_WORKER;
  assert.equal(await mod.maybeStartIncrementalLoop(), false);
  console.log("  ✓ flag unset → incremental loop NOT started");

  // Flag on → the deployed entrypoint starts the loop.
  process.env.TEKMETRIC_INCREMENTAL_ON_WORKER = "true";
  assert.equal(await mod.maybeStartIncrementalLoop(), true);
  console.log("  ✓ flag set → deployed worker entrypoint starts the incremental loop");

  // Idempotent: a second call (e.g. restart race) reports started, not a
  // duplicate loop.
  assert.equal(await mod.maybeStartIncrementalLoop(), true);
  console.log("  ✓ second call is idempotent (single loop instance)");

  const { stopTekmetricIncrementalLoop } = await import(
    "../workers/tekmetric-incremental-loop"
  );
  stopTekmetricIncrementalLoop();
  delete process.env.TEKMETRIC_INCREMENTAL_ON_WORKER;

  console.log("\nAll backfill-drain-worker incremental entrypoint checks passed");
}

main().catch((err) => {
  console.error("entrypoint smoke crashed:", err);
  process.exit(1);
});
