/**
 * Regression smoke test for Task #181 (persist the Tekmetric catch-up
 * run summary so admins can read it later).
 *
 * Run: `npx tsx tests/plan-build-task-181.smoke.ts`
 *
 * Covers:
 *   1. `buildCatchupRunSummary` correctly buckets per-shop outcomes
 *      (completed / recovered / needs-followup / dry-run), captures
 *      filters / timestamps / duration / dryRun, and produces the same
 *      "Suggested re-run command" text the SUMMARY block prints.
 *   2. `persistCatchupRunSummary` inserts into `tekmetric_catchup_runs`
 *      and, after RETENTION more inserts, prunes everything past the
 *      most-recent N runs.
 *   3. Best-effort error handling: a Mongo failure during persistence
 *      surfaces as `{ ok: false, error }` instead of throwing — the
 *      catch-up script must never poison its exit code on a write
 *      hiccup after the real work is done.
 *   4. Sanity: no needs-followup → suggestedRerunCommand is null (no
 *      misleading "rerun nothing" line).
 */

import {
  buildCatchupRunSummary,
  persistCatchupRunSummary,
  CATCHUP_RUN_COLLECTION,
  CATCHUP_RUN_RETENTION,
// @ts-ignore — .mjs sibling module shared with scripts/tekmetric-catchup.mjs
} from "../scripts/lib/catchup-runs.mjs";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #181 regression checks");

async function run() {

// --- 1. buildCatchupRunSummary buckets + filters + suggested re-run ---
{
  const startedAt = new Date("2026-04-29T01:00:00.000Z");
  const finishedAt = new Date("2026-04-29T02:34:56.789Z");
  const summary = buildCatchupRunSummary({
    results: [
      { shopId: 1, outcome: "completed" },
      { shopId: 2, outcome: "recovered" },
      { shopId: 3, outcome: "needs-followup", reason: "stuck on chunk 4 after one retry" },
      { shopId: 4, outcome: "needs-followup", reason: "drain wait exceeded 60min on chunk 2" },
    ],
    dryRun: false,
    onlyShops: [1, 2, 3, 4],
    skipShops: [99],
    startedAt,
    finishedAt,
    prodBaseUrl: "https://mos.tools",
  });

  ok("startedAt is preserved as Date", summary.startedAt instanceof Date && summary.startedAt.getTime() === startedAt.getTime());
  ok("finishedAt is preserved as Date", summary.finishedAt instanceof Date && summary.finishedAt.getTime() === finishedAt.getTime());
  ok("durationMs computed from start/finish", summary.durationMs === finishedAt.getTime() - startedAt.getTime());
  ok("dryRun preserved as boolean", summary.dryRun === false);
  ok("prodBaseUrl preserved", summary.prodBaseUrl === "https://mos.tools");
  ok("filters.onlyShops captured", JSON.stringify(summary.filters.onlyShops) === "[1,2,3,4]");
  ok("filters.skipShops captured", JSON.stringify(summary.filters.skipShops) === "[99]");
  ok("totals.processed == results.length", summary.totals.processed === 4);
  ok("totals.completed == 1", summary.totals.completed === 1);
  ok("totals.recovered == 1", summary.totals.recovered === 1);
  ok("totals.needsFollowup == 2", summary.totals.needsFollowup === 2);
  ok("totals.dryRun == 0", summary.totals.dryRun === 0);
  ok("completedShopIds == [1]", JSON.stringify(summary.completedShopIds) === "[1]");
  ok("recoveredShopIds == [2]", JSON.stringify(summary.recoveredShopIds) === "[2]");
  ok(
    "needsFollowup carries shopId + reason for each entry",
    Array.isArray(summary.needsFollowup) &&
      summary.needsFollowup.length === 2 &&
      summary.needsFollowup[0].shopId === 3 &&
      summary.needsFollowup[0].reason === "stuck on chunk 4 after one retry" &&
      summary.needsFollowup[1].shopId === 4 &&
      summary.needsFollowup[1].reason === "drain wait exceeded 60min on chunk 2",
  );
  ok(
    "suggestedRerunCommand matches the SUMMARY block format",
    summary.suggestedRerunCommand === "ONLY_SHOPS=3,4 node scripts/tekmetric-catchup.mjs",
  );
}

// --- 2. persist + retention prune to last N ---
{
  // In-memory Mongo stand-in just rich enough to support the helper.
  // Cursor methods are chained the way the helper uses them
  // (.find(...).sort(...).limit(...).toArray()).
  type Doc = Record<string, any>;
  const stores: Record<string, Doc[]> = {};
  let nextId = 1;
  function makeCursor(arr: Doc[]) {
    let work = arr.slice();
    let limit: number | null = null;
    const cursor: any = {
      sort(spec: Record<string, 1 | -1>) {
        const keys = Object.entries(spec);
        work.sort((a, b) => {
          for (const [k, dir] of keys) {
            const av = a[k];
            const bv = b[k];
            const an = av instanceof Date ? av.getTime() : av;
            const bn = bv instanceof Date ? bv.getTime() : bv;
            if (an < bn) return -1 * dir;
            if (an > bn) return 1 * dir;
          }
          return 0;
        });
        return cursor;
      },
      limit(n: number) {
        limit = n;
        return cursor;
      },
      async toArray() {
        return limit == null ? work.slice() : work.slice(0, limit);
      },
    };
    return cursor;
  }
  const fakeDb = {
    collection(name: string) {
      if (!stores[name]) stores[name] = [];
      const data = stores[name];
      return {
        async insertOne(doc: Doc) {
          const _id = nextId++;
          data.push({ _id, ...doc });
          return { insertedId: _id };
        },
        find(_filter: any = {}, _opts: any = {}) {
          return makeCursor(data);
        },
        async deleteMany(filter: any) {
          let deleted = 0;
          if (filter && filter._id && Array.isArray(filter._id.$nin)) {
            const keep = new Set(filter._id.$nin);
            for (let i = data.length - 1; i >= 0; i--) {
              if (!keep.has(data[i]._id)) {
                data.splice(i, 1);
                deleted++;
              }
            }
          }
          return { deletedCount: deleted };
        },
      };
    },
  };

  const KEEP = 3;
  // Insert 5 runs in chronological order; expect only the most-recent
  // KEEP=3 to survive after the last insert prunes.
  for (let i = 0; i < 5; i++) {
    const startedAt = new Date(2026, 3, 1 + i, 12, 0, 0);
    const finishedAt = new Date(2026, 3, 1 + i, 12, 30, 0);
    const summary = buildCatchupRunSummary({
      results: [{ shopId: 100 + i, outcome: "completed" }],
      dryRun: false,
      onlyShops: [],
      skipShops: [],
      startedAt,
      finishedAt,
      prodBaseUrl: "https://mos.tools",
    });
    const res = await persistCatchupRunSummary(fakeDb, summary, { keep: KEEP });
    ok(`run #${i} insert ok`, res.ok === true);
  }
  const rows = stores[CATCHUP_RUN_COLLECTION] || [];
  ok(
    "after 5 inserts with keep=3, only the 3 most-recent runs survive",
    rows.length === KEEP,
    `actual=${rows.length}`,
  );
  // Sort-by-startedAt-desc means the surviving runs should be #2, #3, #4.
  const survivingShopIds = rows
    .map((r) => r.completedShopIds?.[0])
    .sort((a: number, b: number) => a - b);
  ok(
    "survivors are the 3 newest catch-up runs (shop ids 102, 103, 104)",
    JSON.stringify(survivingShopIds) === "[102,103,104]",
    `survivingShopIds=${JSON.stringify(survivingShopIds)}`,
  );
  ok(
    "default retention constant exposed and >= 1",
    typeof CATCHUP_RUN_RETENTION === "number" && CATCHUP_RUN_RETENTION >= 1,
  );
}

// --- 3. Best-effort: insertOne throwing surfaces as {ok:false, error} ---
{
  const explodingDb = {
    collection() {
      return {
        async insertOne() {
          throw new Error("boom");
        },
        find() {
          return { sort: () => ({ limit: () => ({ toArray: async () => [] }) }) };
        },
        async deleteMany() {
          return { deletedCount: 0 };
        },
      };
    },
  };
  const summary = buildCatchupRunSummary({
    results: [],
    dryRun: false,
    onlyShops: [],
    skipShops: [],
    startedAt: new Date(),
    finishedAt: new Date(),
    prodBaseUrl: "https://mos.tools",
  });
  const res = await persistCatchupRunSummary(explodingDb, summary);
  ok("write failure surfaces as {ok:false}", res.ok === false);
  ok("write failure carries the error message", typeof res.error === "string" && res.error.includes("boom"));
}

// --- 4. No needs-followup → no suggested re-run command ---
{
  const summary = buildCatchupRunSummary({
    results: [
      { shopId: 1, outcome: "completed" },
      { shopId: 2, outcome: "completed" },
    ],
    dryRun: false,
    onlyShops: [],
    skipShops: [],
    startedAt: new Date("2026-04-29T01:00:00Z"),
    finishedAt: new Date("2026-04-29T01:30:00Z"),
    prodBaseUrl: "https://mos.tools",
  });
  ok(
    "all-clean run leaves suggestedRerunCommand null",
    summary.suggestedRerunCommand === null,
  );
}

// --- 5. Dry-run path is bucketed separately and dryRun flag preserved ---
{
  const summary = buildCatchupRunSummary({
    results: [
      { shopId: 1, outcome: "dry-run" },
      { shopId: 2, outcome: "dry-run" },
    ],
    dryRun: true,
    onlyShops: [1, 2],
    skipShops: [],
    startedAt: new Date("2026-04-29T01:00:00Z"),
    finishedAt: new Date("2026-04-29T01:00:01Z"),
    prodBaseUrl: "https://mos.tools",
  });
  ok("dryRun flag preserved", summary.dryRun === true);
  ok("totals.dryRun == 2", summary.totals.dryRun === 2);
  ok("dryRunShopIds captured", JSON.stringify(summary.dryRunShopIds) === "[1,2]");
  ok(
    "no follow-up bucket entries on dry-run",
    summary.totals.needsFollowup === 0 && summary.suggestedRerunCommand === null,
  );
}

}

run().then(() => {
  if (failed === 0) {
    console.log("\nAll Task #181 regression checks passed.");
    process.exit(0);
  } else {
    console.error(`\n${failed} Task #181 regression check(s) failed.`);
    process.exit(1);
  }
}).catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
