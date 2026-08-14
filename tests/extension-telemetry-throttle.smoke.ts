/**
 * Task #1112 smoke test: the extension's pure telemetry helpers
 * (mos-tools-extension/telemetry-core.js).
 *
 *   1. Signature throttle: first N notes per window emit, the rest are
 *      suppressed but counted; the next emit after a new window carries
 *      the suppressed count (so a render-loop bug can't flood the
 *      pipeline but aggregate volume is preserved).
 *   2. Message sanitizer strips emails, long digit runs, query strings,
 *      caps to 200 chars, and never throws on garbage input.
 *   3. installErrorHooks never throws — even with no window / bad opts —
 *      because telemetry must never break the foreground path.
 *
 * Run: `npx tsx tests/extension-telemetry-throttle.smoke.ts`
 */
import Module from "node:module";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

// Stub `server-only` so the repository module (pure combiner) can load.
const EMPTY_STUB = path.join(__dirname, "..", "scripts", "_stubs", "_empty.cjs");
const origResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
  if (request === "server-only") return EMPTY_STUB;
  return origResolve.call(this, request, ...rest);
};

const require_ = createRequire(__filename);
const core = require_(path.join(__dirname, "..", "mos-tools-extension", "telemetry-core.js"));

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("extension telemetry-core throttle + sanitize (Task #1112)");

// (1) Throttle basics.
{
  const t = core.createSignatureThrottle({ windowMs: 1000, maxPerWindow: 2 });
  const r1 = t.note("sig", 0);
  const r2 = t.note("sig", 10);
  const r3 = t.note("sig", 20);
  const r4 = t.note("sig", 30);
  ok("first two emit", r1.emit && r2.emit);
  ok("third+fourth suppressed", !r3.emit && !r4.emit);
  // New window: emits again and carries the 2 suppressed occurrences.
  const r5 = t.note("sig", 1500);
  ok("new window emits", r5.emit === true);
  ok("suppressed count carried", r5.suppressedSinceLastEmit === 2, `got ${r5.suppressedSinceLastEmit}`);
  // Different signature is independent.
  const other = t.note("other-sig", 40);
  ok("different signature independent", other.emit === true);
}

// (1b) Fail-open on garbage input.
{
  const t = core.createSignatureThrottle({});
  const r = t.note(undefined);
  ok("throttle handles undefined sig", typeof r.emit === "boolean");
}

// (2) Sanitizer.
{
  const s = core.sanitizeErrorMessage;
  ok("strips email", !s("failed for tech@shop.com now").includes("tech@shop.com"));
  ok("strips long digit runs", !s("RO 1234567 failed").includes("1234567"));
  ok("strips query string", !s("fetch https://x.com/a?token=secret failed").includes("token=secret"));
  ok("caps at 200 chars", s("y".repeat(600)).length <= 200);
  ok("first line only (no stack)", !s("Boom\n    at chrome-extension://abc/bg.js:1:1").includes("at chrome"));
  ok("never throws on null", s(null) === "unknown error" || typeof s(null) === "string");
  ok("never throws on object", typeof s({ toString: () => { throw new Error("evil"); } }) === "string");
}

// (2b) Signature is stable + bounded.
{
  const sig = core.errorSignature("sidepanel", "Some Error   With   Spaces " + "z".repeat(300));
  ok("signature includes surface", sig.startsWith("sidepanel|"));
  ok("signature bounded", sig.length <= 100, `len=${sig.length}`);
}

// (3) installErrorHooks never throws into the caller.
{
  let threw = false;
  try {
    core.installErrorHooks(null);
    core.installErrorHooks({});
    core.installErrorHooks({ send: "not a function" });
    // Fake window target — hooks install and a dispatched error reports.
    const listeners: Record<string, Function[]> = {};
    const fakeWin = {
      addEventListener: (name: string, fn: Function) => {
        (listeners[name] = listeners[name] || []).push(fn);
      },
    };
    const sent: any[] = [];
    core.installErrorHooks({
      surface: "content",
      provider: "tekmetric",
      requireExtensionOrigin: true,
      target: fakeWin,
      send: (p: any) => sent.push(p),
    });
    // Page-origin error must be ignored (content scripts share the window).
    listeners["error"][0]({ message: "page boom", filename: "https://shop.tekmetric.com/app.js" });
    ok("page-origin error ignored", sent.length === 0, `sent=${sent.length}`);
    // Extension-origin error must report.
    listeners["error"][0]({ message: "ext boom", filename: "chrome-extension://abc/adapters/tekmetric-content.js" });
    ok("extension-origin error reported", sent.length === 1 && sent[0].surface === "content" && sent[0].provider === "tekmetric");
    // Unhandled rejection with extension stack reports too.
    listeners["unhandledrejection"][0]({ reason: { message: "rej boom", stack: "at chrome-extension://abc/bg.js" } });
    ok("extension rejection reported", sent.length === 2);
    // Listener survives malformed events.
    listeners["error"][0](null);
    listeners["unhandledrejection"][0](undefined);
    ok("hooks survive malformed events", true);
  } catch (e: any) {
    threw = true;
    ok("installErrorHooks never throws", false, e?.message);
  }
  if (!threw) ok("installErrorHooks never throws", true);
}

// (4) buildThrownFetchFailure — thrown fetch paths (network error,
// timeout/abort, delayed retry failure) must emit timing telemetry,
// while errors already reported at their throw site are skipped.
{
  const b = core.buildThrownFetchFailure;
  // Network rejection ("Failed to fetch") — emits with durationMs.
  const net = b("/api/extension/plan", new TypeError("Failed to fetch"), 1234.6);
  ok("network rejection emits", net.emit === true);
  ok("  → durationMs rounded", net.payload.durationMs === 1235, `got ${net.payload.durationMs}`);
  ok("  → status 0 (no response)", net.payload.status === 0);
  ok("  → endpoint carried", net.payload.endpoint === "/api/extension/plan");
  // Timeout/abort error carries its code.
  const t: any = new Error("MOS request timed out");
  t.code = "MOS_REQUEST_TIMEOUT";
  const to = b("/api/extension/canned-jobs", t, 45000);
  ok("timeout emits with code", to.emit === true && to.payload.code === "MOS_REQUEST_TIMEOUT");
  // Delayed retry failure: error thrown AFTER the response-side emit is
  // marked _mosTelemetryReported and must NOT double-report.
  const reported: any = new Error("Session may have expired");
  reported._mosTelemetryReported = true;
  ok("already-reported error skipped", b("/api/extension/plan", reported, 9000).emit === false);
  // Telemetry endpoint itself never reports (feedback loop).
  ok("telemetry endpoint skipped", b("/api/extension/telemetry", new Error("boom"), 100).emit === false);
  // Garbage input fails closed, never throws.
  ok("garbage input safe", b(undefined, null, NaN).emit === true || b(undefined, null, NaN).emit === false);
  // Sanitized reason (no query strings / long digit runs).
  const dirty = b("/x", new Error("fetch https://a.com/b?token=secret RO 1234567 failed"), 10);
  ok("reason sanitized", !dirty.payload.reason.includes("token=secret") && !dirty.payload.reason.includes("1234567"));
}

// (5) Rollup combiner: throttled bursts must count occurrences
// (payload.count), not stored documents — one stored client.error doc
// carrying count=50 is 50 errors, not 1.
async function rollupChecks() {
  const repo = await import("../lib/data/repositories/extension-telemetry");
  const combine = repo.combineTelemetryRollupGroups;

  const rows = combine([
    // Shop 7: a throttled error burst — 3 stored docs, 52 occurrences.
    { mosShopId: 7, event: "client.error", docs: 3, occurrences: 52, lastOccurredAt: "2026-08-13T10:00:00.000Z", durations: [] },
    // Shop 7: throttled slow calls — 2 docs, 9 occurrences, with weighted durations.
    { mosShopId: 7, event: "api.slow_call", docs: 2, occurrences: 9, lastOccurredAt: "2026-08-13T11:00:00.000Z", durations: [{ d: 5100, w: 1 }, { d: 8200, w: 8 }] },
    // Shop 7: plain fetch failures (no count field → occurrences == docs).
    { mosShopId: 7, event: "api.fetch_failure", docs: 4, occurrences: 4, lastOccurredAt: "2026-08-13T09:00:00.000Z", durations: [{ d: 1000, w: 1 }, { d: 45000, w: 1 }] },
    // Shop 9: quiet shop.
    { mosShopId: 9, event: "client.error", docs: 1, occurrences: 1, lastOccurredAt: "2026-08-13T08:00:00.000Z", durations: [] },
  ]);

  const s7 = rows.find((r: any) => r.mosShopId === 7)!;
  ok("burst errorCount uses occurrences", s7.errorCount === 52, `got ${s7.errorCount}`);
  ok("burst slowCallCount uses occurrences", s7.slowCallCount === 9, `got ${s7.slowCallCount}`);
  ok("fetchFailureCount plain", s7.fetchFailureCount === 4);
  ok("totalEvents sums occurrences", s7.totalEvents === 65, `got ${s7.totalEvents}`);
  ok("lastOccurredAt is max across events", s7.lastOccurredAt === "2026-08-13T11:00:00.000Z", `got ${s7.lastOccurredAt}`);
  ok("p95 over merged durations", s7.p95DurationMs === 45000, `got ${s7.p95DurationMs}`);
  ok("shops sorted by volume", rows[0].mosShopId === 7 && rows[1].mosShopId === 9);
  // Defensive: bogus occurrences (0/NaN) fall back to doc count.
  const fb = combine([{ mosShopId: 1, event: "client.error", docs: 2, occurrences: 0, lastOccurredAt: null, durations: [] } as any]);
  ok("bogus occurrences falls back to docs", fb[0].errorCount === 2, `got ${fb[0].errorCount}`);

  // Weighted p95: a count=100 sample must dominate 5 count=1 samples —
  // unweighted-by-document p95 would report 9000 here; weighted is 500.
  const wp95 = repo.weightedP95;
  ok(
    "weighted p95 honors occurrence counts",
    wp95([
      { d: 500, w: 100 },
      { d: 6000, w: 1 },
      { d: 7000, w: 1 },
      { d: 8000, w: 1 },
      { d: 9000, w: 1 },
    ]) === 500,
    `got ${wp95([{ d: 500, w: 100 }, { d: 6000, w: 1 }, { d: 7000, w: 1 }, { d: 8000, w: 1 }, { d: 9000, w: 1 }])}`,
  );
  ok("weighted p95 empty → null", wp95([]) === null);
  ok("weighted p95 single", wp95([{ d: 7000, w: 3 }]) === 7000);
  // Uniform weights match plain nearest-rank behavior at the tail.
  const uniform = Array.from({ length: 100 }, (_, i) => ({ d: (i + 1) * 100, w: 1 }));
  ok("weighted p95 uniform ≈ rank-95", wp95(uniform) === 9500, `got ${wp95(uniform)}`);

  // Rollup uses weighted p95: burst of fast calls in one doc outweighs
  // a handful of slow ones.
  const wrows = combine([
    {
      mosShopId: 3,
      event: "api.slow_call",
      docs: 2,
      occurrences: 101,
      lastOccurredAt: null,
      durations: [{ d: 5200, w: 100 }, { d: 60000, w: 1 }],
    },
  ]);
  ok("rollup p95 is occurrence-weighted", wrows[0].p95DurationMs === 5200, `got ${wrows[0].p95DurationMs}`);

  // Regression (large population): the Mongo aggregation emits one group
  // per (shop, event, duration-bucket) over the COMPLETE matched
  // population — 2500+ bucket groups must all participate in p95. With
  // 2400 fast buckets (weight 1 each) and 100 slow tail buckets carrying
  // weight 24 each (2400 occurrences), the tail is 50% of occurrences,
  // so the weighted p95 MUST land deep in the slow tail. A capped/sliced
  // sample that dropped the late tail would report a fast-bucket value.
  const bigGroups: any[] = [];
  for (let i = 0; i < 2400; i++) {
    bigGroups.push({
      mosShopId: 5, event: "api.slow_call", docs: 1, occurrences: 1,
      lastOccurredAt: null, durations: [{ d: 5000 + i * 50, w: 1 }],
    });
  }
  for (let i = 0; i < 100; i++) {
    bigGroups.push({
      mosShopId: 5, event: "api.slow_call", docs: 1, occurrences: 24,
      lastOccurredAt: null, durations: [{ d: 200000 + i * 50, w: 24 }],
    });
  }
  const big = combine(bigGroups);
  ok(
    "2500-group population: p95 lands in the slow tail",
    big[0].p95DurationMs !== null && big[0].p95DurationMs! >= 200000,
    `got ${big[0].p95DurationMs}`,
  );
  ok("2500-group population: occurrences complete", big[0].slowCallCount === 2400 + 2400, `got ${big[0].slowCallCount}`);

  // Guard: the rollup aggregation must never re-introduce unsorted
  // $push + $slice sampling (biased — can drop the slow tail entirely).
  const repoSrc = fs.readFileSync(
    path.join(__dirname, "..", "lib", "data", "repositories", "extension-telemetry.ts"),
    "utf8",
  );
  ok("rollup aggregation has no $slice sampling", !repoSrc.includes('"$slice"') && !repoSrc.includes("$slice:"));
  ok("rollup aggregation has no $push duration arrays", !repoSrc.includes('"$push"') && !repoSrc.includes("$push:"));
}

rollupChecks()
  .then(() => {
    if (failed > 0) {
      console.error(`\n${failed} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nAll telemetry-core checks passed");
  })
  .catch((err) => {
    console.error("Test crashed:", err);
    process.exit(1);
  });
