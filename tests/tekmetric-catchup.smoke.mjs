/**
 * Smoke test for the Tekmetric prod catch-up runner.
 *
 * Run: `node tests/tekmetric-catchup.smoke.mjs`
 *
 * Locks in the contract added in task #178:
 *   1. A chunk that goes "stuck" gets exactly ONE retry pass per chunk.
 *   2. The retry pass bypasses the looksBusy guard (otherwise a recent
 *      scriptFiredAt + un-advanced metrics — which is exactly the state
 *      after a stuck chunk — would block the retry from ever firing).
 *   3. Stuck → retry → recover buckets the shop as "recovered".
 *   4. Stuck → retry → stuck again buckets the shop as "needs-followup"
 *      with a reason that names the chunk number.
 *   5. A clean completion (no stuck pass) buckets the shop as "completed".
 *   6. The end-of-run summary prints the suggested ONLY_SHOPS=… re-run line
 *      ONLY when at least one shop is in the needs-followup bucket.
 *
 * No live MongoDB, no live POST. processShop() and renderSummary() are
 * imported from the script and driven with a fake getProgress / fake
 * fireChunk / fake sleep + clock so the polling loops run in milliseconds
 * of wall time.
 */

import { processShop, renderSummary } from "../scripts/tekmetric-catchup.mjs";

let failed = 0;
let currentTest = "";

function ok(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function group(name) {
  currentTest = name;
  console.log(`\n${name}`);
}

// ──────────────────────────────────────────────────────────────────────────
// Fake world: virtual clock + per-shop progress doc store + fire-call log.
//
// `setFireBehavior` lets each test plug in a callback that runs after each
// fireChunk and decides what state the shop should be in for the next batch
// of polls (advance / complete / stuck / etc).
// ──────────────────────────────────────────────────────────────────────────

function makeWorld(initialDocsByShop = {}) {
  let virtualTime = 1_700_000_000_000; // arbitrary fixed start (ms epoch)
  const docs = JSON.parse(JSON.stringify(initialDocsByShop), (_k, v) => {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v);
    return v;
  });
  const fireCalls = [];
  const logs = [];

  const now = () => virtualTime;
  const sleep = async (ms) => {
    virtualTime += ms;
  };
  const log = (...args) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  const cloneDoc = (doc) => {
    if (!doc) return null;
    const out = { ...doc };
    if (doc.scriptFiredAt instanceof Date) out.scriptFiredAt = new Date(doc.scriptFiredAt);
    if (doc.lastRunAt instanceof Date) out.lastRunAt = new Date(doc.lastRunAt);
    if (doc.currentChunkEnd instanceof Date) out.currentChunkEnd = new Date(doc.currentChunkEnd);
    if (doc.lastChunkMetrics?.at instanceof Date) {
      out.lastChunkMetrics = { ...doc.lastChunkMetrics, at: new Date(doc.lastChunkMetrics.at) };
    }
    return out;
  };

  const getProgress = async (shopId) => cloneDoc(docs[shopId]);

  let fireBehavior = () => {};
  const fireChunk = async (shopId) => {
    const callIdx = fireCalls.length + 1;
    // Mirror prod: stamp scriptFiredAt on the doc BEFORE the POST goes out.
    docs[shopId] = {
      ...(docs[shopId] || { shopId }),
      scriptFiredAt: new Date(virtualTime),
    };
    fireCalls.push({ shopId, callIdx, virtualTime });
    await fireBehavior({ shopId, callIdx, docs, now: () => virtualTime });
    // Default response: chunk accepted, running on prod (not finishedFast).
    return { status: 0, ms: 1, body: "", finishedFast: false };
  };

  return {
    now,
    sleep,
    log,
    logs,
    getProgress,
    fireChunk,
    fireCalls,
    docs,
    setFireBehavior(fn) {
      fireBehavior = fn;
    },
    setDoc(shopId, doc) {
      docs[shopId] = doc;
    },
  };
}

const baseConfig = {
  PROD_BASE_URL: "https://test.local",
  CRON_SECRET: "test",
  DRY_RUN: false,
  MAX_CHUNKS: 5,
  POLL_INTERVAL_MS: 1_000,
  STUCK_THRESHOLD_MS: 5_000,
  BOOTSTRAP_TIMEOUT: 1_000,
  INTER_SHOP_DELAY: 0,
  STUCK_RETRY_COOLDOWN_MS: 100,
  ONLY_SHOPS: [],
  SKIP_SHOPS: [],
};

const t0Iso = new Date(1_700_000_000_000 - 1_000_000).toISOString();

function dumpLogsOn(failure, logs) {
  if (failure) {
    console.error("    --- captured logs ---");
    for (const line of logs) console.error("    " + line);
    console.error("    ---------------------");
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test 1: clean completion — chunk advances, then completes → "completed".
// ──────────────────────────────────────────────────────────────────────────

await (async () => {
  group("clean completion buckets shop as 'completed'");
  const world = makeWorld({
    42: { shopId: 42, currentChunkEnd: new Date(t0Iso), totalJobsIndexed: 0 },
  });
  world.setFireBehavior(({ callIdx, docs, now }) => {
    if (callIdx === 1) {
      // Chunk 1: advance cursor
      docs[42] = {
        ...docs[42],
        currentChunkEnd: new Date("2024-02-01T00:00:00.000Z"),
        totalJobsIndexed: 100,
        lastChunkMetrics: { at: new Date(now() + 50) },
      };
    } else if (callIdx === 2) {
      // Chunk 2: mark complete
      docs[42] = { ...docs[42], complete: true };
    }
  });
  const failedBefore = failed;
  const result = await processShop(42, {
    getProgress: world.getProgress,
    fireChunk: world.fireChunk,
    config: baseConfig,
    sleep: world.sleep,
    now: world.now,
    log: world.log,
  });
  ok("outcome === 'completed'", result.outcome === "completed", `got ${JSON.stringify(result)}`);
  ok("fireChunk called exactly twice (no retries)", world.fireCalls.length === 2, `got ${world.fireCalls.length}`);
  ok("no stuck-retry log line", !world.logs.some((l) => l.includes("STUCK") || l.includes("[STUCK-RETRY]")), "found a STUCK log line");
  dumpLogsOn(failed > failedBefore, world.logs);
})();

// ──────────────────────────────────────────────────────────────────────────
// Test 2: stuck → retry → recover → "recovered".
// Also asserts: fireChunk called exactly twice for the stuck chunk
// (one initial + one retry; no third fire), and the [STUCK-RETRY] log line
// shows up exactly once.
// ──────────────────────────────────────────────────────────────────────────

await (async () => {
  group("stuck → retry → recover buckets shop as 'recovered'");
  const world = makeWorld({
    7: { shopId: 7, currentChunkEnd: new Date(t0Iso), totalJobsIndexed: 0 },
  });
  world.setFireBehavior(({ callIdx, docs, now }) => {
    if (callIdx === 1) {
      // Chunk 1 first try: hangs / no movement → stuck
    } else if (callIdx === 2) {
      // Chunk 1 retry: cursor advances mid-poll
      docs[7] = {
        ...docs[7],
        currentChunkEnd: new Date("2024-02-01T00:00:00.000Z"),
        totalJobsIndexed: 200,
        lastChunkMetrics: { at: new Date(now() + 50) },
      };
    } else if (callIdx === 3) {
      // Chunk 2: complete
      docs[7] = { ...docs[7], complete: true };
    }
  });
  const failedBefore = failed;
  const result = await processShop(7, {
    getProgress: world.getProgress,
    fireChunk: world.fireChunk,
    config: baseConfig,
    sleep: world.sleep,
    now: world.now,
    log: world.log,
  });
  ok("outcome === 'recovered'", result.outcome === "recovered", `got ${JSON.stringify(result)}`);
  ok(
    "fireChunk called exactly 3 times (chunk1 + chunk1-retry + chunk2)",
    world.fireCalls.length === 3,
    `got ${world.fireCalls.length}`,
  );
  const retryLines = world.logs.filter((l) => l.includes("[STUCK-RETRY]"));
  ok("exactly one [STUCK-RETRY] log entry", retryLines.length === 1, `got ${retryLines.length}`);
  ok(
    "stuck-retry recovery log line emitted",
    world.logs.some((l) => l.includes("Stuck retry recovered")),
    "missing 'Stuck retry recovered' line",
  );
  ok(
    "completion log marks recovered via stuck retry",
    world.logs.some((l) => l.includes("recovered via stuck retry")),
    "missing 'recovered via stuck retry' line",
  );
  dumpLogsOn(failed > failedBefore, world.logs);
})();

// ──────────────────────────────────────────────────────────────────────────
// Test 3: stuck → retry → stuck again → "needs-followup", reason names the
// chunk number. Crucially, retry must fire ONCE — no infinite loop.
// ──────────────────────────────────────────────────────────────────────────

await (async () => {
  group("stuck → retry → stuck again buckets shop as 'needs-followup' (chunk # in reason)");
  const world = makeWorld({
    99: { shopId: 99, currentChunkEnd: new Date(t0Iso), totalJobsIndexed: 0 },
  });
  // fireBehavior never advances — every chunk hangs.
  const failedBefore = failed;
  const result = await processShop(99, {
    getProgress: world.getProgress,
    fireChunk: world.fireChunk,
    config: baseConfig,
    sleep: world.sleep,
    now: world.now,
    log: world.log,
  });
  ok("outcome === 'needs-followup'", result.outcome === "needs-followup", `got ${JSON.stringify(result)}`);
  ok(
    "reason includes 'stuck on chunk 1 after one retry'",
    typeof result.reason === "string" && result.reason.includes("stuck on chunk 1") && result.reason.includes("retry"),
    `got reason=${result.reason}`,
  );
  ok(
    "retry fires exactly ONCE for the stuck chunk (no infinite loop): fireChunk called exactly twice total",
    world.fireCalls.length === 2,
    `got ${world.fireCalls.length}`,
  );
  ok(
    "needs-followup log line emitted",
    world.logs.some((l) => l.includes("STUCK on chunk 1 after retry") && l.includes("needs follow-up")),
    "missing post-retry-stuck log line",
  );
  dumpLogsOn(failed > failedBefore, world.logs);
})();

// ──────────────────────────────────────────────────────────────────────────
// Test 4: looksBusy is bypassed on the retry pass.
//
// After a stuck chunk, the doc has scriptFiredAt set to a recent time and
// lastChunkMetrics.at is older / absent. That state would normally trip
// looksBusy (firedRecently && metrics not advanced past fired stamp). The
// retry pass MUST bypass that guard, otherwise it never re-fires the chunk
// and the recovery never happens — it would silently fall back into a drain
// wait instead of doing the recovery POST.
//
// We assert it bypassed the guard by confirming:
//   - fireChunk was called twice for the stuck chunk (initial + retry).
//   - No "Prod looks busy" log line was emitted on the retry pass.
//   - The shop ultimately recovered (would otherwise sit in drain wait).
// ──────────────────────────────────────────────────────────────────────────

await (async () => {
  group("looksBusy guard is bypassed on the stuck-retry pass");
  const world = makeWorld({
    13: { shopId: 13, currentChunkEnd: new Date(t0Iso), totalJobsIndexed: 0 },
  });
  world.setFireBehavior(({ callIdx, docs, now }) => {
    if (callIdx === 2) {
      docs[13] = {
        ...docs[13],
        currentChunkEnd: new Date("2024-02-01T00:00:00.000Z"),
        totalJobsIndexed: 50,
        lastChunkMetrics: { at: new Date(now() + 50) },
      };
    } else if (callIdx === 3) {
      docs[13] = { ...docs[13], complete: true };
    }
  });
  const failedBefore = failed;
  const result = await processShop(13, {
    getProgress: world.getProgress,
    fireChunk: world.fireChunk,
    config: baseConfig,
    sleep: world.sleep,
    now: world.now,
    log: world.log,
  });
  // Sanity: this is the same retry-recovers scenario, so we should land in
  // recovered. If looksBusy had NOT been bypassed, we would have seen a
  // "Prod looks busy" log on the retry pass and either drained out or
  // returned needs-followup — so this is the canary.
  ok("recovery still completed: outcome === 'recovered'", result.outcome === "recovered", `got ${JSON.stringify(result)}`);
  ok(
    "fireChunk called for the retry pass (not blocked by looksBusy)",
    world.fireCalls.length === 3,
    `got ${world.fireCalls.length} fire calls`,
  );
  ok(
    "no 'Prod looks busy' log line on the retry pass",
    !world.logs.some((l) => l.includes("Prod looks busy")),
    "looksBusy guard fired — bypass regressed",
  );
  ok(
    "retry pass logged with [STUCK-RETRY] marker",
    world.logs.some((l) => l.includes("[STUCK-RETRY]")),
    "missing [STUCK-RETRY] log marker",
  );
  dumpLogsOn(failed > failedBefore, world.logs);
})();

// ──────────────────────────────────────────────────────────────────────────
// Test 5: end-of-run summary renders the suggested ONLY_SHOPS=… re-run line
// only when at least one shop is in the needs-followup bucket.
// ──────────────────────────────────────────────────────────────────────────

await (async () => {
  group("renderSummary: ONLY_SHOPS=… line appears only for needs-followup bucket");

  // Case A: mixed bucket (one of each kind) — the line MUST appear with
  // exactly the needs-followup shop IDs.
  const linesA = renderSummary(
    [
      { shopId: 5,  outcome: "completed" },
      { shopId: 7,  outcome: "recovered" },
      { shopId: 9,  outcome: "needs-followup", reason: "stuck on chunk 3 after one retry" },
      { shopId: 11, outcome: "needs-followup", reason: "did not complete after 5 chunks" },
    ],
    { dryRun: false },
    () => {}, // swallow logs in the test
  );
  ok(
    "summary lists completed bucket with shopId 5",
    linesA.some((l) => l.startsWith("Completed cleanly (1):") && l.includes("5")),
    "missing or wrong 'Completed cleanly' line",
  );
  ok(
    "summary lists recovered bucket with shopId 7",
    linesA.some((l) => l.startsWith("Recovered via stuck-retry (1):") && l.includes("7")),
    "missing or wrong 'Recovered via stuck-retry' line",
  );
  ok(
    "summary lists needs-followup bucket count = 2",
    linesA.some((l) => l.startsWith("Needs follow-up (2):")),
    "missing or wrong 'Needs follow-up' header",
  );
  ok(
    "summary lists needs-followup reason for shop 9 (chunk 3 in reason)",
    linesA.some((l) => l.includes("shop 9") && l.includes("chunk 3")),
    "missing reason line for shop 9",
  );
  ok(
    "summary renders the suggested ONLY_SHOPS=9,11 re-run line",
    linesA.some((l) => l.includes("ONLY_SHOPS=9,11 node scripts/tekmetric-catchup.mjs")),
    "missing or wrong ONLY_SHOPS line",
  );

  // Case B: no needs-followup — the line MUST NOT appear.
  const linesB = renderSummary(
    [
      { shopId: 5, outcome: "completed" },
      { shopId: 7, outcome: "recovered" },
    ],
    { dryRun: false },
    () => {},
  );
  ok(
    "no ONLY_SHOPS line when nothing is in needs-followup",
    !linesB.some((l) => l.includes("ONLY_SHOPS=")),
    "ONLY_SHOPS line leaked into all-clean summary",
  );
  ok(
    "no 'Suggested re-run command' header when nothing is in needs-followup",
    !linesB.some((l) => l.includes("Suggested re-run command")),
    "'Suggested re-run command' leaked into all-clean summary",
  );
  ok(
    "needs-followup header still shown with '(none)' tag",
    linesB.some((l) => l === "Needs follow-up (0): (none)"),
    "missing '(none)' needs-followup header",
  );

  // Case C: dry-run shows the dry-run bucket line; still no ONLY_SHOPS
  // (dry-run shops aren't follow-up shops).
  const linesC = renderSummary(
    [{ shopId: 3, outcome: "dry-run" }],
    { dryRun: true },
    () => {},
  );
  ok(
    "dry-run summary shows the dry-run bucket line",
    linesC.some((l) => l.startsWith("Dry-run (would have fired) (1):") && l.includes("3")),
    "missing dry-run bucket line",
  );
  ok(
    "no ONLY_SHOPS line in dry-run summary",
    !linesC.some((l) => l.includes("ONLY_SHOPS=")),
    "ONLY_SHOPS line leaked into dry-run summary",
  );
})();

// ──────────────────────────────────────────────────────────────────────────

if (failed === 0) {
  console.log("\nAll tekmetric-catchup smoke checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} tekmetric-catchup smoke check(s) failed.`);
  process.exit(1);
}
