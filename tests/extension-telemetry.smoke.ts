/**
 * Task #516 smoke test: `/api/extension/telemetry` (task #511) is a
 * privacy-sensitive, best-effort observability sink. The two highest-risk
 * pieces have no automated coverage, so this test pins them down via the
 * route's `__deps` test seam:
 *
 *   1. The payload sanitizer MUST drop unknown fields so an extension
 *      regression can't exfiltrate VINs / inspection text / tokens into the
 *      events collection — only the fixed allow-list is persisted.
 *   2. The endpoint sanitizer MUST strip numeric IDs and query strings so a
 *      raw RO id / token never lands in telemetry.
 *   3. The 120/min/shop rate limit MUST 429 instead of writing unbounded
 *      rows.
 *   4. Batches larger than the per-batch cap MUST be rejected (413).
 *
 * Run: `npx tsx tests/extension-telemetry.smoke.ts`
 */

import Module from "node:module";
import path from "node:path";
import { NextRequest } from "next/server";

// The route transitively imports `lib/rate` → `lib/db/repositories/wave1`,
// which pulls in `server-only` (throws on load outside an RSC). Same stub
// the repo's drain scripts use, registered before the dynamic route import
// so this test runs standalone via `npx tsx`.
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

// ---- Fakes wired through the route's __deps seam -------------------------

// Captured inserts from the fake Mongo collection.
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

// Counting rate limiter that honors the `limit` passed by the route so the
// 120/min threshold is exercised for real (not hard-coded in the fake).
const rateCounts = new Map<string, number>();
async function countingRateLimit(opts: {
  id: string;
  limit: number;
  windowSeconds: number;
}) {
  const c = (rateCounts.get(opts.id) ?? 0) + 1;
  rateCounts.set(opts.id, c);
  return {
    allowed: c <= opts.limit,
    remaining: Math.max(0, opts.limit - c),
    limit: opts.limit,
    resetAt: new Date(Date.now() + opts.windowSeconds * 1000),
    bucketKey: opts.id,
  };
}

function makeReq(events: any[], extra: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("http://localhost/api/extension/telemetry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer ext_test_token",
    },
    body: JSON.stringify({ events, ...extra }),
  });
}

async function run() {
  console.log("extension-telemetry sanitizer + rate limit (Task #516)");

  const routeMod = await import("../app/api/extension/telemetry/route");
  const { POST, __deps } = routeMod as any;

  // Authorized user on every request.
  __deps.validateExtensionToken = async () => ({
    authorized: true,
    user: { _id: "u1", email: "tech@shop.com", role: "user", shopId: 7 },
  });
  // Every shop resolves to mosShopId 7.
  __deps.findShopBySmsId = async () => ({ mosShopId: 7, shopDoc: {}, provider: "tekmetric" });
  __deps.getDb = async () => fakeDb;
  __deps.rateLimit = countingRateLimit;

  function reset() {
    inserted = [];
    rateCounts.clear();
  }

  // (1) Payload sanitizer drops everything outside the allow-list.
  {
    reset();
    const res = await POST(
      makeReq([
        {
          event: "api.fetch_failure",
          smsShopId: "1001",
          payload: {
            // allow-listed scalars (should survive)
            code: "EXT_5XX",
            status: 503,
            // disallowed — must be dropped server-side
            vin: "1HGCM82633A004352",
            inspectionText: "front brakes worn to 2mm, customer concern",
            token: "ext_super_secret_token_value",
            customerName: "Jane Doe",
            nested: { foo: "bar" },
          },
        },
      ]),
    );
    ok("payload event → 200", res.status === 200, `got ${res.status}`);
    ok("payload event → 1 doc stored", inserted.length === 1, `len=${inserted.length}`);
    const p = inserted[0]?.payload ?? {};
    const keys = Object.keys(p).sort();
    ok(
      "only allow-listed payload keys persist",
      keys.length === 2 && keys[0] === "code" && keys[1] === "status",
      `keys=${JSON.stringify(keys)}`,
    );
    ok("  → code preserved", p.code === "EXT_5XX", `code=${p.code}`);
    ok("  → status preserved", p.status === 503, `status=${p.status}`);
    ok("  → vin dropped", !("vin" in p));
    ok("  → inspectionText dropped", !("inspectionText" in p));
    ok("  → token dropped", !("token" in p));
    ok("  → customerName dropped", !("customerName" in p));
    ok("  → nested object dropped", !("nested" in p));
  }

  // (2) Endpoint sanitizer strips numeric ids and the query string.
  {
    reset();
    const res = await POST(
      makeReq([
        {
          event: "api.fetch_failure",
          smsShopId: "1001",
          endpoint: "/api/foo/12345/bar?token=secret",
        },
      ]),
    );
    ok("endpoint event → 200", res.status === 200, `got ${res.status}`);
    const ep = inserted[0]?.endpoint;
    ok(
      "numeric id replaced + query string stripped",
      ep === "/api/foo/{id}/bar",
      `endpoint=${ep}`,
    );
  }

  // (2b) Task #884: context.incomplete is accepted and its payload keeps only
  // the shape/boolean/hint-key fields — hint keys are scrubbed of digits so a
  // VIN or RO number can never ride along.
  {
    reset();
    const res = await POST(
      makeReq([
        {
          event: "context.incomplete",
          smsShopId: "1360",
          provider: "autoflow",
          payload: {
            provider: "autoflow",
            urlShape: "v4_dvi",
            hasShopId: true,
            hasRoId: true,
            hasVin: false,
            hasMileage: false,
            hintKeys: ["vin", "mileage_field", "odo123meter", "customerName!"],
            vin: "1HGCM82633A004352", // must be dropped
            pageText: "secret content", // must be dropped
          },
        },
      ]),
    );
    ok("context.incomplete → 200", res.status === 200, `got ${res.status}`);
    ok("context.incomplete stored", inserted.length === 1, `len=${inserted.length}`);
    const p = inserted[0]?.payload ?? {};
    ok("  → urlShape preserved", p.urlShape === "v4_dvi", `urlShape=${p.urlShape}`);
    ok("  → booleans preserved", p.hasShopId === true && p.hasVin === false);
    ok(
      "  → hintKeys scrubbed of non-letters",
      Array.isArray(p.hintKeys) &&
        p.hintKeys.join(",") === "vin,mileage_field,odometer,customerName",
      `hintKeys=${JSON.stringify(p.hintKeys)}`,
    );
    ok("  → vin dropped", !("vin" in p));
    ok("  → pageText dropped", !("pageText" in p));
  }

  // (2c) Unknown event names are still rejected (allow-list intact).
  {
    reset();
    const res = await POST(
      makeReq([{ event: "context.bogus_event", smsShopId: "1360" }]),
    );
    ok("unknown event → 200 but rejected", res.status === 200);
    ok("  → nothing stored", inserted.length === 0, `len=${inserted.length}`);
  }

  // (3) The 121st request in a window returns 429 (limit is 120/min).
  {
    reset();
    let last: any = null;
    for (let i = 1; i <= 120; i++) {
      last = await POST(makeReq([{ event: "action.dropped", smsShopId: "1001" }]));
    }
    ok("120th request still accepted", last.status === 200, `got ${last.status}`);
    const over = await POST(makeReq([{ event: "action.dropped", smsShopId: "1001" }]));
    ok("121st request → 429", over.status === 429, `got ${over.status}`);
    const body = await over.json().catch(() => ({}));
    ok("  → body reports rate limit", /rate limit/i.test(body?.error || ""), JSON.stringify(body));
    ok(
      "  → no rows written for the 429",
      inserted.length === 120,
      `inserted=${inserted.length}`,
    );
  }

  // (4) Batches larger than the per-batch cap (50) are rejected with 413.
  {
    reset();
    const events = Array.from({ length: 51 }, () => ({
      event: "action.dropped",
      smsShopId: "1001",
    }));
    const res = await POST(makeReq(events));
    ok("51-event batch → 413", res.status === 413, `got ${res.status}`);
    ok("  → nothing inserted", inserted.length === 0, `inserted=${inserted.length}`);
    // A batch exactly at the cap is still accepted.
    reset();
    const okBatch = Array.from({ length: 50 }, () => ({
      event: "action.dropped",
      smsShopId: "1001",
    }));
    const res2 = await POST(makeReq(okBatch));
    ok("50-event batch → 200", res2.status === 200, `got ${res2.status}`);
    ok("  → 50 rows stored", inserted.length === 50, `inserted=${inserted.length}`);
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
