/**
 * Task #1112 smoke test: background-level timing telemetry for the MOS
 * fetch proxy. Loads the `handleMosApiRequest` slice of
 * `mos-tools-extension/background.js` in a vm sandbox (same harness as
 * tests/extension-401-retry-policy.smoke.ts) with the REAL
 * telemetry-core module, and asserts that every terminal path emits
 * duration/slow-call telemetry:
 *
 *   1. Slow success → api.slow_call with durationMs + status.
 *   2. Slow 503 (transient) → api.fetch_failure carries durationMs AND
 *      an api.slow_call is emitted (status 503, once — no dedup miss).
 *   3. Slow soft-expired 401 (retry exhaustion) → auth.soft_expired has
 *      durationMs + slow-call emitted; no duplicate fetch_failure.
 *   4. Slow terminal 401 (token cleared) → token_invalid_cleared has
 *      durationMs + slow-call emitted.
 *   5. Thrown network error → api.fetch_failure (status 0) with
 *      durationMs + slow-call; caller still sees the original error.
 *   6. Fast success → NO slow-call event (threshold respected).
 *
 * Run: `npx tsx tests/extension-timing-telemetry.smoke.ts`
 */

import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const telemetryCore = require_(
  path.join(__dirname, "..", "mos-tools-extension", "telemetry-core.js"),
);

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface Emitted {
  event: string;
  payload: any;
}

function loadHandler() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "mos-tools-extension", "background.js"),
    "utf8",
  );
  const startMarker = "// Task #502: 401 retry policy.";
  const endMarker = "\n  return response.json();\n}";
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker, startIdx);
  if (startIdx < 0 || endIdx < 0) throw new Error("could not locate handleMosApiRequest slice");
  const slice = src.slice(startIdx, endIdx + endMarker.length);

  // Fake clock: fetch advances it so we can simulate slow calls without
  // real waiting.
  const clock = { now: 1_000_000 };
  const events: Emitted[] = [];

  const context: any = {
    console,
    setTimeout: (fn: any) => fn(),
    clearTimeout: () => {},
    AbortController,
    Promise,
    Error,
    Set,
    Math,
    JSON,
    Date: { now: () => clock.now },
    MosTelemetryCore: telemetryCore,
    reportTelemetry: (event: string, payload: any) => events.push({ event, payload }),
    // Real slow-call decision, minus the background's throttle plumbing:
    // mirror its contract (threshold check + emit) against the real core
    // threshold so the "no slow event under threshold" case is honest.
    reportSlowCallIfNeeded: (endpoint: string, durationMs: number, status: number) => {
      if (typeof durationMs !== "number" || durationMs < telemetryCore.SLOW_CALL_THRESHOLD_MS) return;
      if (endpoint && endpoint.indexOf("/api/extension/telemetry") !== -1) return;
      events.push({ event: "api.slow_call", payload: { endpoint, durationMs, status } });
    },
    chrome: {
      storage: {
        local: {
          get: (_k: any, cb: any) => cb({}),
          remove: (_k: any, cb?: any) => { if (cb) cb(); },
        },
      },
    },
    fetch: async () => { throw new Error("fetch not stubbed"); },
    encodeURIComponent,
    currentSmsContext: null,
    mosApiToken: "ext_token",
    mosApiUrl: "http://test",
    _stateReady: Promise.resolve(),
    handleMosLogin: async () => { throw new Error("re-auth disabled"); },
    // Tiered-session bootstrap (v1.33.4): a no-op here — this suite tests
    // timing/telemetry attribution, not session-tier bootstrap behavior.
    ensureBootstrapBoundToActiveTab: async () => {},
  };
  vm.createContext(context);
  vm.runInContext(slice + "\nthis.__handleMosApiRequest = handleMosApiRequest;", context);
  return { ctx: context, clock, events };
}

function jsonResponse(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(text),
    clone() { return jsonResponse(status, body); },
  } as any;
}

const byEvent = (events: Emitted[], name: string) => events.filter((e) => e.event === name);

async function run() {
  console.log("extension timing telemetry (Task #1112)");

  // (1) Slow success → api.slow_call.
  {
    const { ctx, clock, events } = loadHandler();
    ctx.fetch = async () => { clock.now += 8000; return jsonResponse(200, { ok: true }); };
    const res = await ctx.__handleMosApiRequest("/api/extension/plan", {});
    ok("slow success returns data", res?.ok === true);
    const slow = byEvent(events, "api.slow_call");
    ok("slow success → 1 slow_call", slow.length === 1, `got ${slow.length}`);
    ok("  → durationMs + status", slow[0]?.payload.durationMs === 8000 && slow[0]?.payload.status === 200, JSON.stringify(slow[0]?.payload));
    ok("  → no fetch_failure", byEvent(events, "api.fetch_failure").length === 0);
  }

  // (2) Slow 503 → fetch_failure with durationMs AND exactly one slow_call.
  // The shop context is switched MID-FLIGHT; failure attribution must
  // stay pinned to the request-start snapshot.
  {
    const { ctx, clock, events } = loadHandler();
    ctx.currentSmsContext = { provider: "tekmetric", shopId: "shopX" };
    ctx.fetch = async () => {
      clock.now += 9000;
      ctx.currentSmsContext = { provider: "tekmetric", shopId: "shopY" }; // tab switch mid-request
      return jsonResponse(503, { error: "warming", code: "AUTH_LOOKUP_FAILED" });
    };
    let threw: any = null;
    try { await ctx.__handleMosApiRequest("/api/extension/plan", {}); } catch (e) { threw = e; }
    ok("503 still throws to caller", threw?.code === "MOS_SERVER_TRANSIENT", threw?.message);
    const ff = byEvent(events, "api.fetch_failure");
    ok("503 → exactly 1 fetch_failure", ff.length === 1, `got ${ff.length}`);
    ok("  → fetch_failure has durationMs", ff[0]?.payload.durationMs === 9000, JSON.stringify(ff[0]?.payload));
    const slow = byEvent(events, "api.slow_call");
    ok("slow 503 → exactly 1 slow_call", slow.length === 1, `got ${slow.length}`);
    ok("  → slow_call status 503", slow[0]?.payload.status === 503);
    ok("  → 503 failure pinned to start snapshot", ff[0]?.payload.smsShopId === "shopX", `got ${ff[0]?.payload.smsShopId}`);
  }

  // (3) Retry exhaustion → soft-expired 401: durationMs + slow_call, no dup fetch_failure.
  {
    const { ctx, clock, events } = loadHandler();
    ctx.currentSmsContext = { provider: "tekmetric", shopId: "shopX" };
    ctx.fetch = async () => {
      clock.now += 2000;
      ctx.currentSmsContext = { provider: "tekmetric", shopId: "shopY" };
      return jsonResponse(401, { error: "x", code: "AUTH_LOOKUP_FAILED" });
    };
    let threw: any = null;
    try { await ctx.__handleMosApiRequest("/api/extension/plan", {}); } catch (e) { threw = e; }
    ok("soft 401 throws soft error", threw?.code === "MOS_SESSION_SOFT_EXPIRED", threw?.message);
    ok("  → token preserved", ctx.mosApiToken === "ext_token");
    const soft = byEvent(events, "auth.soft_expired");
    ok("soft_expired emitted with durationMs", soft.length === 1 && typeof soft[0].payload.durationMs === "number" && soft[0].payload.durationMs >= 5000, JSON.stringify(soft[0]?.payload));
    ok("soft_expired pinned to start snapshot", soft[0]?.payload.smsShopId === "shopX", `got ${soft[0]?.payload.smsShopId}`);
    const slow = byEvent(events, "api.slow_call");
    ok("retry exhaustion → slow_call emitted", slow.length === 1 && slow[0].payload.status === 401, `got ${slow.length}`);
    ok("  → no duplicate fetch_failure", byEvent(events, "api.fetch_failure").length === 0);
  }

  // (4) Terminal 401 (token cleared) → durationMs + slow_call.
  {
    const { ctx, clock, events } = loadHandler();
    ctx.fetch = async () => { clock.now += 2000; return jsonResponse(401, { error: "x", code: "TOKEN_INVALID" }); };
    let threw: any = null;
    try { await ctx.__handleMosApiRequest("/api/extension/plan", {}); } catch (e) { threw = e; }
    ok("terminal 401 throws", threw != null);
    ok("  → token cleared", ctx.mosApiToken === null);
    const cleared = byEvent(events, "auth.token_invalid_cleared");
    ok("token_invalid_cleared has durationMs", cleared.length === 1 && typeof cleared[0].payload.durationMs === "number" && cleared[0].payload.durationMs >= 5000, JSON.stringify(cleared[0]?.payload));
    ok("terminal 401 → slow_call emitted", byEvent(events, "api.slow_call").length === 1);
  }

  // (5) Thrown network error → fetch_failure status 0 + slow_call; caller sees original error.
  {
    const { ctx, clock, events } = loadHandler();
    ctx.currentSmsContext = { provider: "tekmetric", shopId: "shopX" };
    ctx.fetch = async () => {
      clock.now += 7000;
      ctx.currentSmsContext = { provider: "tekmetric", shopId: "shopY" };
      throw new TypeError("Failed to fetch");
    };
    let threw: any = null;
    try { await ctx.__handleMosApiRequest("/api/extension/plan", {}); } catch (e) { threw = e; }
    ok("network error rethrown to caller", threw?.message === "Failed to fetch", threw?.message);
    const ff = byEvent(events, "api.fetch_failure");
    ok("thrown path → 1 fetch_failure", ff.length === 1, `got ${ff.length}`);
    ok("  → status 0 + durationMs", ff[0]?.payload.status === 0 && ff[0]?.payload.durationMs === 7000, JSON.stringify(ff[0]?.payload));
    ok("  → thrown failure pinned to start snapshot", ff[0]?.payload.smsShopId === "shopX", `got ${ff[0]?.payload.smsShopId}`);
    ok("thrown path → slow_call emitted", byEvent(events, "api.slow_call").length === 1);
  }

  // (6) Fast success → no slow_call.
  {
    const { ctx, clock, events } = loadHandler();
    ctx.fetch = async () => { clock.now += 300; return jsonResponse(200, { ok: true }); };
    await ctx.__handleMosApiRequest("/api/extension/plan", {});
    ok("fast success → no telemetry at all", events.length === 0, JSON.stringify(events));
  }

  // (7) Cross-shop throttle isolation — load the REAL Task #1112 helper
  // block (reportClientError / reportSlowCallIfNeeded) and verify that
  // suppressed occurrences from shop A never fold into an event
  // attributed to shop B, and that attribution pins to the snapshot.
  {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "mos-tools-extension", "background.js"),
      "utf8",
    );
    const start = src.indexOf("// -------------------- Task #1112: client error + slow-call telemetry");
    const end = src.indexOf("// Task #502: 401 retry policy.");
    if (start < 0 || end < 0 || end <= start) throw new Error("could not locate Task #1112 helper slice");
    const helperSlice = src.slice(start, end);

    const emitted: Emitted[] = [];
    const hctx: any = {
      console,
      Math,
      String,
      JSON,
      Date,
      MosTelemetryCore: telemetryCore,
      currentSmsContext: { provider: "tekmetric", shopId: "shopA" },
      reportTelemetry: (event: string, payload: any) => emitted.push({ event, payload }),
      self: { addEventListener: () => {} },
    };
    vm.createContext(hctx);
    vm.runInContext(
      helperSlice + "\nthis.__slow = reportSlowCallIfNeeded; this.__err = reportClientError; this.__relay = handleRelayedTelemetry; this.__relayPending = _relayPendingCounts;",
      hctx,
    );

    // Exhaust shop A's slow-call budget (2/min per shop+endpoint).
    hctx.__slow("/api/extension/plan", 8000, 200);
    hctx.__slow("/api/extension/plan", 8000, 200);
    hctx.__slow("/api/extension/plan", 8000, 200); // suppressed for shop A
    ok("shop A: 2 emits then suppression", emitted.length === 2);
    // Same endpoint, shop B context snapshot → independent bucket, count=1
    // (shop A's suppressed call must NOT be folded in).
    hctx.__slow("/api/extension/plan", 9000, 200, { provider: "tekmetric", shopId: "shopB" });
    ok("shop B slow_call emits independently", emitted.length === 3);
    ok("  → count=1 (no cross-shop carryover)", emitted[2].payload.count === 1, `count=${emitted[2].payload.count}`);
    ok("  → attributed to shop B snapshot", emitted[2].payload.smsShopId === "shopB");
    // Global context mutated mid-flight: snapshot still wins.
    hctx.currentSmsContext = { provider: "tekmetric", shopId: "shopC" };
    hctx.__slow("/api/extension/vhi", 7000, 200, { provider: "tekmetric", shopId: "shopA" });
    ok("snapshot beats mutated global context", emitted[3].payload.smsShopId === "shopA", `got ${emitted[3].payload.smsShopId}`);
    // client.error: same message from two shops throttles per shop.
    hctx.currentSmsContext = { provider: "tekmetric", shopId: "shopA" };
    for (let i = 0; i < 5; i++) hctx.__err("sidepanel", "Boom render loop");
    const errsA = emitted.filter((e) => e.event === "client.error");
    ok("shop A errors throttled at 3", errsA.length === 3, `got ${errsA.length}`);
    hctx.currentSmsContext = { provider: "tekmetric", shopId: "shopB" };
    hctx.__err("sidepanel", "Boom render loop");
    const errsAll = emitted.filter((e) => e.event === "client.error");
    ok("shop B same-signature error emits fresh", errsAll.length === 4 && errsAll[3].payload.count === 1 && errsAll[3].payload.smsShopId === "shopB", JSON.stringify(errsAll[3]?.payload));

    // Relayed telemetry: a sender-scoped payload keeps its own shop even
    // if the background's context differs; an unscoped one is stamped at
    // receipt (and pinned, so a later context change can't rewrite it).
    hctx.currentSmsContext = { provider: "tekmetric", shopId: "shopC" };
    hctx.__relay("client.error", { surface: "sidepanel", message: "scoped", count: 1, smsShopId: "shopA" });
    const relayed1 = emitted[emitted.length - 1];
    ok("relay keeps sender-scoped shop", relayed1.payload.smsShopId === "shopA", `got ${relayed1.payload.smsShopId}`);
    hctx.__relay("client.error", { surface: "content", message: "unscoped", count: 1 });
    const relayed2 = emitted[emitted.length - 1];
    ok("relay stamps unscoped error at receipt", relayed2.payload.smsShopId === "shopC", `got ${relayed2.payload.smsShopId}`);

    // Relay-side authoritative throttle: a content script whose local
    // throttle wasn't shop-aware relays the same signature repeatedly;
    // the relay throttles per shop and NEVER carries suppressed counts
    // across a shop switch.
    const before = emitted.length;
    for (let i = 0; i < 6; i++) {
      hctx.__relay("client.error", { surface: "content", message: "relay loop", count: 2, smsShopId: "shopA" });
    }
    const shopAEmits = emitted.slice(before);
    ok("relay throttles shop A at 3 emits", shopAEmits.length === 3, `got ${shopAEmits.length}`);
    // Shop switch mid-suppression: shop B gets a FRESH bucket with only
    // its own occurrences (shop A has 3 suppressed relays × count 2 = 6
    // pending occurrences that must NOT leak here).
    hctx.__relay("client.error", { surface: "content", message: "relay loop", count: 2, smsShopId: "shopB" });
    const bEmit = emitted[emitted.length - 1];
    ok("relay shop switch → fresh bucket", bEmit.payload.smsShopId === "shopB", JSON.stringify(bEmit.payload));
    ok("  → no cross-shop suppressed carryover", bEmit.payload.count === 2, `count=${bEmit.payload.count}`);
    // Shop A's suppressed occurrences (3 relays × count 2 = 6) stay
    // pending in shop A's own bucket, keyed by the shop-scoped signature.
    const pendingA = hctx.__relayPending.get(
      `relay|shopA|${telemetryCore.errorSignature("content", telemetryCore.sanitizeErrorMessage("relay loop"))}`,
    );
    ok("  → suppressed occurrences pend under shop A only", pendingA === 6 && hctx.__relayPending.size === 1, `pendingA=${pendingA} size=${hctx.__relayPending.size}`);
  }

  // (8) installErrorHooks getScope: shop switch on a persistent surface
  // opens a fresh throttle bucket — no count carryover across shops.
  {
    const listeners: Record<string, Function[]> = {};
    const fakeWin = { addEventListener: (n: string, f: Function) => { (listeners[n] = listeners[n] || []).push(f); } };
    const sent: any[] = [];
    let scope = "shopA";
    telemetryCore.installErrorHooks({
      surface: "sidepanel",
      target: fakeWin,
      getScope: () => scope,
      send: (p: any) => sent.push(p),
    });
    for (let i = 0; i < 5; i++) listeners["error"][0]({ message: "panel boom" });
    ok("getScope shop A throttles at 3", sent.length === 3, `got ${sent.length}`);
    ok("  → scoped payloads carry shop", sent.every((p) => p.smsShopId === "shopA"));
    scope = "shopB";
    listeners["error"][0]({ message: "panel boom" });
    ok("shop switch → fresh bucket emits", sent.length === 4);
    ok("  → count=1, no cross-shop carryover", sent[3].count === 1 && sent[3].smsShopId === "shopB", JSON.stringify(sent[3]));
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll timing-telemetry checks passed");
}

run().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
