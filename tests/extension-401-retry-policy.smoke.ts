/**
 * Task #502 smoke test for the extension client's 401 retry policy.
 *
 * We load `mos-tools-extension/background.js` in a synthetic
 * environment (`chrome.storage`, `fetch`, `setTimeout`) and exercise
 * `handleMosApiRequest` end-to-end:
 *
 *   1. One 401 then 200: succeeds without clearing the token.
 *   2. N consecutive 401s with `code: TOKEN_INVALID` + no saved creds:
 *      retries exhaust, token IS cleared.
 *   3. N consecutive 401s with `code: AUTH_LOOKUP_FAILED`: retries
 *      exhaust, token is NEVER cleared (transient), throws soft error.
 *   4. 503 response: token is NEVER cleared.
 *
 * The script reads `background.js`, strips chrome-extension top-level
 * `chrome.*` listener registration that would explode under Node, and
 * `vm.runInThisContext`s just the function definitions we need.
 *
 * Run: `npx tsx tests/extension-401-retry-policy.smoke.ts`
 */

import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function loadHandler() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "mos-tools-extension", "background.js"),
    "utf8",
  );
  // Extract the slice we care about — from `// Task #502: 401 retry
  // policy.` through the end of `handleMosApiRequest`.
  const startMarker = "// Task #502: 401 retry policy.";
  const endMarker = "\n  return response.json();\n}";
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker, startIdx);
  if (startIdx < 0 || endIdx < 0) {
    throw new Error("could not locate handleMosApiRequest slice");
  }
  const slice = src.slice(startIdx, endIdx + endMarker.length);

  const context: any = {
    console,
    setTimeout: (fn: any, _ms: any) => fn(),  // collapse delays in tests
    clearTimeout: () => {},
    // `_doMosFetch` (added by the fetch-timeout task) arms an
    // AbortController per attempt; the vm context only exposes ES
    // intrinsics, so Node globals must be injected explicitly.
    AbortController,
    // `handleMosApiRequest` reports auth telemetry; the function lives
    // above the extracted slice, so stub it as a no-op (the test asserts
    // token state + error codes, not telemetry).
    reportTelemetry: () => {},
    // Task #1112 timing telemetry — the slice calls these plus Date.now
    // and MosTelemetryCore; this test asserts token state, not telemetry.
    reportSlowCallIfNeeded: () => {},
    MosTelemetryCore: { buildThrownFetchFailure: () => ({ emit: false, payload: null }) },
    Date,
    Promise,
    Error,
    Set,
    Math,
    JSON,
    chrome: {
      storage: {
        local: {
          get: (_keys: any, cb: any) => cb({}),
          remove: (_keys: any, cb?: any) => { if (cb) cb(); },
        },
      },
    },
    fetch: async () => { throw new Error("fetch not stubbed"); },
    encodeURIComponent,
    currentSmsContext: null,
    mosApiToken: null,
    mosApiUrl: "http://test",
    _stateReady: Promise.resolve(),
    ensureBootstrapBoundToActiveTab: async () => {},
    handleMosLogin: async () => { throw new Error("re-auth disabled"); },
  };
  vm.createContext(context);
  // Wrap so handleMosApiRequest is reachable; the slice uses
  // `function` declarations so it's hoisted.
  vm.runInContext(slice + "\nthis.__handleMosApiRequest = handleMosApiRequest;", context);
  return context;
}

function makeJsonResponse(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(text),
    clone() { return makeJsonResponse(status, body); },
  } as any;
}

async function run() {
  console.log("extension 401 retry policy (Task #502)");

  // (1) one 401 then 200 — token NOT cleared
  {
    const ctx = loadHandler();
    ctx.mosApiToken = "ext_keep_me";
    let removed: boolean = false;
    ctx.chrome.storage.local.remove = (_k: any, cb?: any) => { removed = true; if (cb) cb(); };
    let calls = 0;
    ctx.fetch = async () => {
      calls += 1;
      if (calls === 1) return makeJsonResponse(401, { error: "x", code: "TOKEN_INVALID" });
      return makeJsonResponse(200, { ok: true });
    };
    const result = await ctx.__handleMosApiRequest("/api/extension/features", {});
    ok("one 401 then 200 → succeeds", result?.ok === true, JSON.stringify(result));
    ok("  → token preserved", ctx.mosApiToken === "ext_keep_me");
    ok("  → token NOT removed from storage", removed === false);
    ok("  → called fetch at least twice", calls >= 2, `calls=${calls}`);
  }

  // (2) sustained TOKEN_INVALID + no saved creds → token IS cleared
  {
    const ctx = loadHandler();
    ctx.mosApiToken = "ext_doomed";
    let removed = Boolean(false);
    ctx.chrome.storage.local.remove = (_k: any, cb?: any) => { removed = true; if (cb) cb(); };
    ctx.fetch = async () => makeJsonResponse(401, { error: "x", code: "TOKEN_INVALID" });
    let threw: any = null;
    try {
      await ctx.__handleMosApiRequest("/api/extension/features", {});
    } catch (e) { threw = e; }
    ok("sustained TOKEN_INVALID → throws", threw != null);
    ok("  → token cleared", ctx.mosApiToken === null);
    ok("  → token removed from storage", removed === true);
  }

  // (3) sustained AUTH_LOOKUP_FAILED 401 → token preserved, soft error
  {
    const ctx = loadHandler();
    ctx.mosApiToken = "ext_keep_me_through_blip";
    let removed: boolean = false;
    ctx.chrome.storage.local.remove = (_k: any, cb?: any) => { removed = true; if (cb) cb(); };
    ctx.fetch = async () => makeJsonResponse(401, { error: "x", code: "AUTH_LOOKUP_FAILED" });
    let threw: any = null;
    try {
      await ctx.__handleMosApiRequest("/api/extension/features", {});
    } catch (e) { threw = e; }
    ok("AUTH_LOOKUP_FAILED 401 → throws", threw != null);
    ok("  → token preserved", ctx.mosApiToken === "ext_keep_me_through_blip");
    ok("  → token NOT removed from storage", removed === false);
    ok(
      "  → soft error code",
      threw?.code === "MOS_SESSION_SOFT_EXPIRED",
      `code=${threw?.code}`,
    );
  }

  // (3b) sustained TOKEN_EXPIRED → terminal: token IS cleared (Task #760).
  // A server-side hard expiry means the token is dead; keeping it left the
  // extension false-authed on long shifts. One 401 blip still never clears —
  // the retry budget + silent re-auth must all fail first (covered by (1)).
  {
    const ctx = loadHandler();
    ctx.mosApiToken = "ext_expired_doomed";
    let removed = Boolean(false);
    ctx.chrome.storage.local.remove = (_k: any, cb?: any) => { removed = true; if (cb) cb(); };
    ctx.fetch = async () => makeJsonResponse(401, { error: "x", code: "TOKEN_EXPIRED" });
    let threw: any = null;
    try {
      await ctx.__handleMosApiRequest("/api/extension/features", {});
    } catch (e) { threw = e; }
    ok("sustained TOKEN_EXPIRED → throws", threw != null);
    ok("  → token cleared (TOKEN_EXPIRED is terminal)", ctx.mosApiToken === null);
    ok("  → token removed from storage", removed === true);
  }

  // (3b-ii) one TOKEN_EXPIRED blip then 200 → token preserved (retry absorbs it)
  {
    const ctx = loadHandler();
    ctx.mosApiToken = "ext_expired_blip_keep";
    let removed: boolean = false;
    ctx.chrome.storage.local.remove = (_k: any, cb?: any) => { removed = true; if (cb) cb(); };
    let calls = 0;
    ctx.fetch = async () => {
      calls += 1;
      if (calls === 1) return makeJsonResponse(401, { error: "x", code: "TOKEN_EXPIRED" });
      return makeJsonResponse(200, { ok: true });
    };
    const result = await ctx.__handleMosApiRequest("/api/extension/features", {});
    ok("one TOKEN_EXPIRED then 200 → succeeds", result?.ok === true, JSON.stringify(result));
    ok("  → token preserved", ctx.mosApiToken === "ext_expired_blip_keep");
    ok("  → token NOT removed from storage", removed === false);
  }

  // (3c) sustained SHOP_FORBIDDEN → token preserved (route-scope, not credential)
  {
    const ctx = loadHandler();
    ctx.mosApiToken = "ext_shop_forbidden_keep";
    let removed: boolean = false;
    ctx.chrome.storage.local.remove = (_k: any, cb?: any) => { removed = true; if (cb) cb(); };
    ctx.fetch = async () => makeJsonResponse(401, { error: "x", code: "SHOP_FORBIDDEN" });
    let threw: any = null;
    try {
      await ctx.__handleMosApiRequest("/api/extension/features", {});
    } catch (e) { threw = e; }
    ok("SHOP_FORBIDDEN → throws", threw != null);
    ok("  → token preserved (SHOP_FORBIDDEN is soft)", ctx.mosApiToken === "ext_shop_forbidden_keep");
    ok("  → token NOT removed from storage", removed === false);
    ok(
      "  → soft error code",
      threw?.code === "MOS_SESSION_SOFT_EXPIRED",
      `code=${threw?.code}`,
    );
  }

  // (4) 503 → token preserved
  {
    const ctx = loadHandler();
    ctx.mosApiToken = "ext_503";
    let removed: boolean = false;
    ctx.chrome.storage.local.remove = (_k: any, cb?: any) => { removed = true; if (cb) cb(); };
    ctx.fetch = async () => makeJsonResponse(503, { error: "down", code: "AUTH_LOOKUP_FAILED" });
    let threw: any = null;
    try {
      await ctx.__handleMosApiRequest("/api/extension/features", {});
    } catch (e) { threw = e; }
    ok("503 → throws", threw != null);
    ok("  → token preserved", ctx.mosApiToken === "ext_503");
    ok("  → token NOT removed from storage", removed === false);
    ok(
      "  → transient error code",
      threw?.code === "MOS_SERVER_TRANSIENT",
      `code=${threw?.code}`,
    );
  }

  // (5) Task #657 — a widened per-request retry budget rides out a
  // transient blip that the DEFAULT budget cannot. The default budget is
  // 1 initial fetch + 3 retries = 4 attempts. A blip that returns 401 on
  // attempts 1-5 and 200 on attempt 6 outlasts the default but is
  // absorbed by a 5-retry override.
  {
    // (5a) control: default budget gives up before the blip clears.
    const ctx = loadHandler();
    ctx.mosApiToken = "ext_default_budget";
    let calls = 0;
    ctx.fetch = async () => {
      calls += 1;
      if (calls <= 5) return makeJsonResponse(401, { error: "blip", code: "AUTH_LOOKUP_FAILED" });
      return makeJsonResponse(200, { ok: true });
    };
    let threw: any = null;
    try {
      await ctx.__handleMosApiRequest("/api/extension/jobs/apply-canned", { method: "POST" });
    } catch (e) { threw = e; }
    ok("default budget gives up before a 6-deep blip clears", threw != null);
    ok("  → exactly 4 attempts (1 + 3 retries)", calls === 4, `calls=${calls}`);
    ok("  → token preserved (transient)", ctx.mosApiToken === "ext_default_budget");
    ok("  → soft error code", threw?.code === "MOS_SESSION_SOFT_EXPIRED", `code=${threw?.code}`);
  }
  {
    // (5b) widened budget rides the same blip out to success.
    const ctx = loadHandler();
    ctx.mosApiToken = "ext_wide_budget";
    let removed: boolean = false;
    ctx.chrome.storage.local.remove = (_k: any, cb?: any) => { removed = true; if (cb) cb(); };
    let calls = 0;
    ctx.fetch = async () => {
      calls += 1;
      if (calls <= 5) return makeJsonResponse(401, { error: "blip", code: "AUTH_LOOKUP_FAILED" });
      return makeJsonResponse(200, { ok: true });
    };
    const result = await ctx.__handleMosApiRequest("/api/extension/jobs/apply-canned", {
      method: "POST",
      authRetryDelaysMs: [1, 1, 1, 1, 1],
    });
    ok("widened budget rides out the blip → succeeds", result?.ok === true, JSON.stringify(result));
    ok("  → reached the 6th attempt", calls === 6, `calls=${calls}`);
    ok("  → token preserved", ctx.mosApiToken === "ext_wide_budget");
    ok("  → token NOT removed from storage", removed === false);
  }
  {
    // (5c) a genuinely dead credential is still terminal even with a
    // widened budget — TOKEN_INVALID persists, so the token is cleared.
    const ctx = loadHandler();
    ctx.mosApiToken = "ext_wide_but_dead";
    let removed = Boolean(false);
    ctx.chrome.storage.local.remove = (_k: any, cb?: any) => { removed = true; if (cb) cb(); };
    ctx.fetch = async () => makeJsonResponse(401, { error: "x", code: "TOKEN_INVALID" });
    let threw: any = null;
    try {
      await ctx.__handleMosApiRequest("/api/extension/jobs/apply-canned", {
        method: "POST",
        authRetryDelaysMs: [1, 1, 1, 1, 1],
      });
    } catch (e) { threw = e; }
    ok("widened budget still clears a sustained TOKEN_INVALID", threw != null);
    ok("  → token cleared", ctx.mosApiToken === null);
    ok("  → token removed from storage", removed === true);
  }

  if (failed > 0) {
    console.error(`\nFAILED ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(2);
});
