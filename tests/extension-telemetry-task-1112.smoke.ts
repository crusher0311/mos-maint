/**
 * Task #1112 smoke test: the telemetry route accepts the two new event
 * types (api.slow_call, client.error), keeps dropping unknown names, and
 * enforces the server-side slow-call floor:
 *
 *   1. api.slow_call with durationMs >= threshold is stored with
 *      durationMs / thresholdMs / count / status persisted.
 *   2. api.slow_call below EXTENSION_SLOW_CALL_THRESHOLD_MS (default
 *      5000) is rejected — a client with a lower threshold can't flood.
 *   3. client.error is stored with surface / message / count, message
 *      clamped to 200 chars, and disallowed fields (stack, url) dropped.
 *   4. Unknown event names are still rejected (one-sided allowlist
 *      changes silently lose data — this pins the server side).
 *   5. api.fetch_failure now persists durationMs.
 *
 * Run: `npx tsx tests/extension-telemetry-task-1112.smoke.ts`
 */

import Module from "node:module";
import path from "node:path";
import { NextRequest } from "next/server";

const EMPTY_STUB = path.join(__dirname, "..", "scripts", "_stubs", "_empty.cjs");
const origResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
  if (request === "server-only") return EMPTY_STUB;
  return origResolve.call(this, request, ...rest);
};

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

let inserted: any[] = [];
const fakeDb = {
  collection: (_name: string) => ({
    createIndex: async () => ({}),
    insertMany: async (docs: any[]) => {
      inserted.push(...docs);
      return { insertedCount: docs.length };
    },
  }),
} as any;

function makeReq(events: any[]): NextRequest {
  return new NextRequest("http://localhost/api/extension/telemetry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer ext_test_token",
    },
    body: JSON.stringify({ events, extensionVersion: "1.33.0" }),
  });
}

async function run() {
  console.log("extension-telemetry new events (Task #1112)");

  const routeMod = await import("../app/api/extension/telemetry/route");
  const { POST, __deps } = routeMod as any;

  __deps.validateExtensionToken = async () => ({
    authorized: true,
    user: { _id: "u1", email: "tech@shop.com", role: "user", shopId: 7 },
  });
  __deps.findShopBySmsId = async () => ({ mosShopId: 7, shopDoc: {}, provider: "tekmetric" });
  __deps.getDb = async () => fakeDb;
  __deps.rateLimit = async () => ({ allowed: true });

  function reset() {
    inserted = [];
  }

  // (1) api.slow_call at/above threshold is accepted with fields persisted.
  {
    reset();
    const res = await POST(
      makeReq([
        {
          event: "api.slow_call",
          smsShopId: "1001",
          endpoint: "/api/extension/plan?vin=x",
          payload: { durationMs: 8123, thresholdMs: 5000, status: 200, count: 3 },
        },
      ]),
    );
    const body = await res.json();
    ok("slow_call → 200", res.status === 200, `got ${res.status}`);
    ok("slow_call accepted", body.accepted === 1 && inserted.length === 1, JSON.stringify(body));
    const p = inserted[0]?.payload ?? {};
    ok("  → durationMs persisted", p.durationMs === 8123, `durationMs=${p.durationMs}`);
    ok("  → thresholdMs persisted", p.thresholdMs === 5000);
    ok("  → count persisted", p.count === 3);
    ok("  → status persisted", p.status === 200);
    ok("  → endpoint query stripped", inserted[0].endpoint === "/api/extension/plan", `ep=${inserted[0].endpoint}`);
  }

  // (2) slow_call below the server floor is rejected.
  {
    reset();
    const res = await POST(
      makeReq([
        { event: "api.slow_call", smsShopId: "1001", endpoint: "/api/extension/plan", payload: { durationMs: 1200 } },
        { event: "api.slow_call", smsShopId: "1001", endpoint: "/api/extension/plan", payload: {} },
      ]),
    );
    const body = await res.json();
    ok("below-threshold slow_call rejected", body.accepted === 0 && body.rejected === 2, JSON.stringify(body));
    ok("  → nothing stored", inserted.length === 0, `len=${inserted.length}`);
  }

  // (2b) env override raises the floor.
  {
    reset();
    process.env.EXTENSION_SLOW_CALL_THRESHOLD_MS = "10000";
    const res = await POST(
      makeReq([
        { event: "api.slow_call", smsShopId: "1001", payload: { durationMs: 8123 } },
      ]),
    );
    const body = await res.json();
    ok("env-raised floor drops 8s call", body.accepted === 0 && body.rejected === 1, JSON.stringify(body));
    delete process.env.EXTENSION_SLOW_CALL_THRESHOLD_MS;
  }

  // (3) client.error stored with surface/message/count; junk dropped.
  {
    reset();
    const longMsg = "x".repeat(500);
    const res = await POST(
      makeReq([
        {
          event: "client.error",
          smsShopId: "1001",
          payload: {
            surface: "sidepanel",
            message: longMsg,
            count: 4,
            stack: "Error at chrome-extension://abc/sidepanel.js:1:1",
            url: "https://shop.tekmetric.com/ro/12345?token=secret",
          },
        },
      ]),
    );
    const body = await res.json();
    ok("client.error → accepted", body.accepted === 1 && inserted.length === 1, JSON.stringify(body));
    const p = inserted[0]?.payload ?? {};
    ok("  → surface persisted", p.surface === "sidepanel");
    ok("  → message clamped to 200", typeof p.message === "string" && p.message.length === 200, `len=${p.message?.length}`);
    ok("  → count persisted", p.count === 4);
    ok("  → stack dropped", !("stack" in p));
    ok("  → url dropped", !("url" in p));
  }

  // (3b) Hostile client.error message: a valid token can send RAW text,
  // so the SERVER must redact PII/secrets — never trust the extension's
  // client-side sanitizer.
  {
    reset();
    const res = await POST(
      makeReq([
        {
          event: "client.error",
          smsShopId: "1001",
          payload: {
            surface: "sidepanel",
            message:
              "fetch https://mos.example/api/plan?token=supersecret failed for jane.doe@customer.com VIN 1234567890 RO 987654\n    at chrome-extension://abc/sidepanel.js:10:5",
          },
        },
      ]),
    );
    const body = await res.json();
    ok("hostile message accepted (event valid)", body.accepted === 1, JSON.stringify(body));
    const msg = inserted[0]?.payload?.message as string;
    ok("  → query string redacted", !msg.includes("token=supersecret"), msg);
    ok("  → email redacted", !msg.includes("jane.doe@customer.com"), msg);
    ok("  → long digit runs redacted", !msg.includes("1234567890") && !msg.includes("987654"), msg);
    ok("  → stack line stripped (first line only)", !msg.includes("at chrome-extension"), msg);
  }

  // (3c) Per-shop rate limiting within a mixed batch: shop 42 is over its
  // budget, shop 7 is not — shop 7's events must still be stored and the
  // limiter must be consulted with a DISTINCT bucket per shop (never just
  // the batch's first event).
  {
    reset();
    const seenBuckets: string[] = [];
    __deps.rateLimit = async ({ id }: any) => {
      seenBuckets.push(id);
      return { allowed: !id.includes("shop:42") };
    };
    const res = await POST(
      makeReq([
        { event: "client.error", smsShopId: "42", payload: { surface: "content", message: "flood" } },
        { event: "client.error", smsShopId: "7", payload: { surface: "content", message: "fine" } },
        { event: "client.error", smsShopId: "42", payload: { surface: "content", message: "flood 2" } },
      ]),
    );
    const body = await res.json();
    ok("mixed batch not rejected wholesale", res.status === 200, `status=${res.status}`);
    ok("allowed shop's event stored", body.accepted === 1 && inserted.length === 1 && inserted[0].smsShopId === "7", JSON.stringify(body));
    ok("limited shop's events dropped + counted", body.rateLimited === 2, JSON.stringify(body));
    ok(
      "one limiter bucket per distinct shop",
      seenBuckets.some((b) => b.includes("shop:42")) && seenBuckets.some((b) => b.includes("shop:7")) && seenBuckets.length === 2,
      JSON.stringify(seenBuckets),
    );
    // All buckets denied → 429 as before.
    reset();
    __deps.rateLimit = async () => ({ allowed: false });
    const res429 = await POST(makeReq([{ event: "client.error", smsShopId: "42", payload: { surface: "content", message: "x" } }]));
    ok("fully-limited batch → 429", res429.status === 429, `status=${res429.status}`);
    __deps.rateLimit = async () => ({ allowed: true });
  }

  // (4) Unknown event names still rejected.
  {
    reset();
    const res = await POST(
      makeReq([{ event: "totally.made_up", smsShopId: "1001", payload: {} }]),
    );
    const body = await res.json();
    ok("unknown event rejected", body.accepted === 0 && body.rejected === 1, JSON.stringify(body));
  }

  // (5) api.fetch_failure carries durationMs now.
  {
    reset();
    const res = await POST(
      makeReq([
        {
          event: "api.fetch_failure",
          smsShopId: "1001",
          endpoint: "/api/extension/plan",
          payload: { status: 503, durationMs: 45210 },
        },
      ]),
    );
    const body = await res.json();
    ok("fetch_failure accepted", body.accepted === 1, JSON.stringify(body));
    ok("  → durationMs persisted", inserted[0]?.payload?.durationMs === 45210);
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll Task #1112 telemetry route checks passed");
}

run().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
