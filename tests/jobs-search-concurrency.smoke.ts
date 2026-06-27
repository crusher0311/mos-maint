/**
 * Smoke test for the concurrent job-search orchestration (task #692).
 *
 * Run: `npx tsx tests/jobs-search-concurrency.smoke.ts`
 *
 * The two job-search routes (extension side panel + dashboard) used to run the
 * canonical Postgres arm and the legacy Mongo `job_index` arm SEQUENTIALLY:
 * Postgres first, Mongo only as a fallback when Postgres returned nothing. For
 * enterprise multi-word searches the Postgres arm alone takes ~16s, so the user
 * waited ~16s before the Mongo fallback even started — and that fallback then
 * timed out, returning zero.
 *
 * `selectCombinedResults` runs both arms concurrently. This test pins the
 * behaviour contract without a live database by feeding it fake promises:
 *   - Fast non-empty Postgres → serve Postgres (canonical preference preserved).
 *   - Empty Postgres → serve the (fast) Mongo arm.
 *   - SLOW Postgres → serve Mongo PROMPTLY, never blocking on the slow arm.
 *   - Both empty → source "none".
 *   - Results are deduped per arm.
 */

import { selectCombinedResults } from "../lib/job-search-combined";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const pgRow = (workOrderId: string, title: string) => ({
  workOrderId,
  job: { title },
  sourceSystem: "tekmetric",
});
const mongoRow = (workOrderId: string, title: string) => ({
  workOrderId,
  job: { title },
  dataSource: "job_index",
});

async function run() {
  console.log("jobs-search-concurrency smoke");

  // 1. Fast non-empty Postgres → canonical PG wins.
  {
    const r = await selectCombinedResults(
      Promise.resolve([pgRow("1", "spark plug")]),
      Promise.resolve([mongoRow("1", "spark plug")]),
      50,
    );
    ok("fast non-empty Postgres serves canonical PG", r.source === "supabase", `source=${r.source}`);
    ok("PG path returns its rows", r.jobs.length === 1);
  }

  // 2. Empty Postgres → fall back to Mongo.
  {
    const r = await selectCombinedResults(
      Promise.resolve([]),
      Promise.resolve([mongoRow("7", "brake pad")]),
      50,
    );
    ok("empty Postgres falls back to Mongo", r.source === "mongo", `source=${r.source}`);
    ok("Mongo path returns its rows", r.jobs.length === 1);
  }

  // 3. SLOW Postgres → serve Mongo promptly, do NOT wait for the slow arm.
  {
    const start = Date.now();
    const r = await selectCombinedResults(
      delay(5000, [pgRow("9", "oil change")]), // simulates the ~16s enterprise PG arm
      Promise.resolve([mongoRow("9", "oil change")]),
      120, // grace window
    );
    const elapsed = Date.now() - start;
    ok("slow Postgres → Mongo served", r.source === "mongo", `source=${r.source}`);
    ok(
      "slow Postgres does NOT block (returned within grace, not 5s)",
      elapsed < 1000,
      `elapsed=${elapsed}ms`,
    );
  }

  // 4. Postgres slightly slower than Mongo but within grace → canonical PG still wins.
  {
    const r = await selectCombinedResults(
      delay(40, [pgRow("3", "rotation")]),
      Promise.resolve([mongoRow("3", "rotation")]),
      300,
    );
    ok("PG within grace window still preferred", r.source === "supabase", `source=${r.source}`);
  }

  // 5. Both empty → source "none".
  {
    const r = await selectCombinedResults(Promise.resolve([]), Promise.resolve([]), 50);
    ok("both empty → source none", r.source === "none" && r.jobs.length === 0, `source=${r.source}`);
  }

  // 6. Dedup within the chosen arm.
  {
    const r = await selectCombinedResults(
      Promise.resolve([pgRow("5", "coolant flush"), pgRow("5", "coolant flush")]),
      Promise.resolve([]),
      50,
    );
    ok("PG duplicates collapse", r.jobs.length === 1, `jobs=${r.jobs.length}`);
    ok("supabaseCount reflects raw rows (pre-dedup)", r.supabaseCount === 2);
  }

  if (failed > 0) {
    console.error(`\n${failed} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
