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
    mosApiToken: null,
    mosApiUrl: "http://test",
    _stateReady: Promise.resolve(),
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
    let removed = false;
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
    let removed = false;
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
    let removed = false;
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

  // (3b) sustained TOKEN_EXPIRED → token preserved (soft, not terminal)
  {
    const ctx = loadHandler();
    ctx.mosApiToken = "ext_expired_keep";
    let removed = false;
    ctx.chrome.storage.local.remove = (_k: any, cb?: any) => { removed = true; if (cb) cb(); };
    ctx.fetch = async () => makeJsonResponse(401, { error: "x", code: "TOKEN_EXPIRED" });
    let threw: any = null;
    try {
      await ctx.__handleMosApiRequest("/api/extension/features", {});
    } catch (e) { threw = e; }
    ok("TOKEN_EXPIRED → throws", threw != null);
    ok("  → token preserved (TOKEN_EXPIRED is soft)", ctx.mosApiToken === "ext_expired_keep");
    ok("  → token NOT removed from storage", removed === false);
    ok(
      "  → soft error code",
      threw?.code === "MOS_SESSION_SOFT_EXPIRED",
      `code=${threw?.code}`,
    );
  }

  // (3c) sustained SHOP_FORBIDDEN → token preserved (route-scope, not credential)
  {
    const ctx = loadHandler();
    ctx.mosApiToken = "ext_shop_forbidden_keep";
    let removed = false;
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
    let removed = false;
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
