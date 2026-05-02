/**
 * Smoke test for the Tekmetric endpoint-health pipeline added in task #224.
 *
 * Run: `npx tsx tests/tekmetric-endpoint-health.smoke.ts`
 *
 * Covers two route handlers via the `__deps` test seam on each:
 *
 *   1. POST /api/extension/tek-endpoint-report — sanitization (numeric path
 *      segments → `{id}`), defensive drops for missing/hostile shapes, the
 *      auth + CORS gate, and the inserted-doc shape on the happy path.
 *
 *   2. GET /api/admin/tekmetric-endpoint-health — the platform-admin guard
 *      and the JS-side rollup transform (errorRate / fullyFailing /
 *      percentile / lookback fields). The aggregation `aggregate()` call is
 *      stubbed to return canned grouped rows so we exercise the post-Mongo
 *      transform end-to-end without needing a fake-mongo `$cond/$push/$max`
 *      implementation.
 *
 * No real Mongo / network involvement.
 */
import { NextRequest } from "next/server";

// `lib/auth.ts` (imported by the admin health route) pulls in the
// `server-only` package, which throws when loaded outside a Server
// Component build. Stub it via require.cache BEFORE the route modules
// are imported so the static import graph resolves cleanly.
const serverOnlyPath = require.resolve("server-only");
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {},
} as any;

const ingestModule = require("../app/api/extension/tek-endpoint-report/route");
const healthModule = require("../app/api/admin/tekmetric-endpoint-health/route");
const { POST, OPTIONS, __deps: ingestDeps } = ingestModule;
const { GET: healthGET, __deps: healthDeps } = healthModule;

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ORIGINAL_INGEST = { ...ingestDeps };
const ORIGINAL_HEALTH = { ...healthDeps };

type InsertedBatch = { docs: any[]; opts: any };

function makeIngestFakeDb() {
  const inserted: InsertedBatch[] = [];
  const indexes: any[] = [];
  const db = {
    collection(_name: string) {
      return {
        async createIndex(spec: any, opts?: any) {
          indexes.push({ spec, opts });
          return "fake_index";
        },
        async insertMany(docs: any[], opts: any) {
          inserted.push({ docs: docs.map((d) => ({ ...d })), opts });
          return { insertedCount: docs.length };
        },
      };
    },
  };
  return { db, inserted, indexes };
}

function installIngest(opts: {
  db?: any;
  authorized?: boolean;
  authError?: string | null;
  user?: any;
  shopMap?: Record<string, number | null>;
}) {
  ingestDeps.getDb = (async () => opts.db) as any;
  ingestDeps.validateExtensionToken = (async () => ({
    authorized: opts.authorized !== false,
    user:
      opts.user === undefined
        ? { email: "ext@example.com", role: "user", shopId: 1 }
        : opts.user,
    error: opts.authError ?? null,
  })) as any;
  ingestDeps.findShopBySmsId = (async (smsShopId: string) => {
    const map = opts.shopMap ?? {};
    if (!(smsShopId in map)) return null;
    const v = map[smsShopId];
    return v == null
      ? null
      : { mosShopId: v, shopDoc: { shopId: v }, provider: "tekmetric" };
  }) as any;
}

function makeIngestRequest(body: any) {
  return new NextRequest("http://localhost/api/extension/tek-endpoint-report", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer ext_test",
    },
    body: JSON.stringify(body),
  });
}

async function run() {
  console.log("tekmetric-endpoint-health smoke");

  // ============================================================
  // POST /api/extension/tek-endpoint-report
  // ============================================================

  // (1) Sanitization: `/repair-orders/12345/foo?x=1` → `/repair-orders/{id}/foo`,
  //     and protocol+host stripped. Verifies PII / RO numbers cannot leak
  //     into Mongo even if the extension's client-side strip is bypassed.
  {
    const fake = makeIngestFakeDb();
    installIngest({ db: fake.db, shopMap: { "11": 42 } });

    const now = Date.now();
    const res = await POST(
      makeIngestRequest({
        reports: [
          {
            endpointShape:
              "https://shop.tekmetric.com/api/shop/1234/repair-orders/56789/summary?secret=abc#frag",
            method: "GET",
            status: 200,
            elapsedMs: 120,
            occurredAt: now,
            smsShopId: "11",
            label: "ro-summary",
          },
        ],
      }),
    );
    ok("sanitize: 200 OK", res.status === 200);
    ok(
      "sanitize: CORS Allow-Origin set on success",
      res.headers.get("Access-Control-Allow-Origin") === "*",
    );
    const body = await res.json();
    ok("sanitize: 1 accepted", body.accepted === 1);
    ok("sanitize: 0 rejected", body.rejected === 0);
    ok("sanitize: exactly one insertMany batch", fake.inserted.length === 1);

    const doc = fake.inserted[0]?.docs[0];
    ok(
      "sanitize: stored shape replaces RO + shop ids with {id}",
      doc?.endpointShape === "/api/shop/{id}/repair-orders/{id}/summary",
      `endpointShape=${doc?.endpointShape}`,
    );
    ok(
      "sanitize: query string and fragment removed",
      typeof doc?.endpointShape === "string" &&
        !doc.endpointShape.includes("?") &&
        !doc.endpointShape.includes("#") &&
        !doc.endpointShape.includes("secret"),
    );
    ok(
      "sanitize: protocol+host stripped",
      typeof doc?.endpointShape === "string" &&
        !doc.endpointShape.includes("tekmetric.com"),
    );
    ok(
      "sanitize: literal RO number 56789 never present",
      typeof doc?.endpointShape === "string" &&
        !doc.endpointShape.includes("56789") &&
        !doc.endpointShape.includes("1234"),
    );
    ok("sanitize: insertMany ordered=false", fake.inserted[0].opts?.ordered === false);
    ok("sanitize: doc.mosShopId resolved from smsShopId", doc?.mosShopId === 42);
    ok("sanitize: isError=false for status 200", doc?.isError === false);
  }

  // (2) Defensive drops: items missing endpointShape, with non-string /
  //     hostile shapes, or invalid status/elapsedMs are dropped — not
  //     500'd. Verifies the route never crashes on malformed batches.
  {
    const fake = makeIngestFakeDb();
    installIngest({ db: fake.db, shopMap: { "11": 42 } });
    const now = Date.now();
    const res = await POST(
      makeIngestRequest({
        reports: [
          // Missing endpointShape entirely
          { status: 200, elapsedMs: 50, occurredAt: now, smsShopId: "11" },
          // Hostile shape: object instead of string
          {
            endpointShape: { drop: "table" },
            status: 200,
            elapsedMs: 50,
            occurredAt: now,
            smsShopId: "11",
          },
          // Hostile shape: array
          {
            endpointShape: ["/a", "/b"],
            status: 200,
            elapsedMs: 50,
            occurredAt: now,
            smsShopId: "11",
          },
          // Empty string shape
          {
            endpointShape: "",
            status: 200,
            elapsedMs: 50,
            occurredAt: now,
            smsShopId: "11",
          },
          // Invalid status
          {
            endpointShape: "/api/foo",
            status: "not-a-number",
            elapsedMs: 50,
            occurredAt: now,
            smsShopId: "11",
          },
          // One good one to confirm partial-success batching
          {
            endpointShape: "/api/healthy",
            status: 200,
            elapsedMs: 50,
            occurredAt: now,
            smsShopId: "11",
          },
        ],
      }),
    );
    ok("hostile: 200 (never 500 on malformed items)", res.status === 200);
    const body = await res.json();
    ok("hostile: rejected count >= 5", body.rejected >= 5, `body=${JSON.stringify(body)}`);
    ok("hostile: 1 accepted (the lone good item)", body.accepted === 1);
    ok(
      "hostile: only the good item was inserted",
      fake.inserted.length === 1 &&
        fake.inserted[0].docs.length === 1 &&
        fake.inserted[0].docs[0].endpointShape === "/api/healthy",
    );
  }

  // (3) Batching shape: status >= 400 marked isError, status 0 (network
  //     error sentinel) also marked isError, reportedAt populated.
  {
    const fake = makeIngestFakeDb();
    installIngest({ db: fake.db, shopMap: { "11": 42 } });
    const now = Date.now();
    const res = await POST(
      makeIngestRequest({
        reports: [
          { endpointShape: "/api/a", status: 200, elapsedMs: 10, occurredAt: now, smsShopId: "11" },
          { endpointShape: "/api/a", status: 500, elapsedMs: 10, occurredAt: now, smsShopId: "11" },
          { endpointShape: "/api/a", status: 0, elapsedMs: 10, occurredAt: now, smsShopId: "11" },
        ],
      }),
    );
    ok("batching: 200", res.status === 200);
    ok("batching: 3 docs inserted", fake.inserted[0]?.docs.length === 3);
    const docs = fake.inserted[0].docs;
    ok("batching: status 200 → isError=false", docs[0].isError === false);
    ok("batching: status 500 → isError=true", docs[1].isError === true);
    ok("batching: status 0 → isError=true (network sentinel)", docs[2].isError === true);
    ok(
      "batching: every doc carries reportedAt+occurredAt Date",
      docs.every(
        (d: any) => d.reportedAt instanceof Date && d.occurredAt instanceof Date,
      ),
    );
  }

  // (4) Auth/CORS gate: unauthorized → 401 with CORS headers, no DB writes.
  {
    const fake = makeIngestFakeDb();
    installIngest({
      db: fake.db,
      authorized: false,
      authError: "Invalid token",
      user: null,
    });
    const res = await POST(makeIngestRequest({ reports: [] }));
    ok("auth: 401 when validateExtensionToken denies", res.status === 401);
    ok(
      "auth: 401 still carries CORS Allow-Origin",
      res.headers.get("Access-Control-Allow-Origin") === "*",
    );
    ok("auth: no DB writes on deny", fake.inserted.length === 0);
  }

  // (5) Body shape gate: missing `reports` array → 400; bad JSON → 400.
  {
    const fake = makeIngestFakeDb();
    installIngest({ db: fake.db });
    const res = await POST(makeIngestRequest({ notReports: 1 }));
    ok("body: 400 when reports missing", res.status === 400);

    const badJsonReq = new NextRequest(
      "http://localhost/api/extension/tek-endpoint-report",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: "Bearer ext_test",
        },
        body: "{not json",
      },
    );
    const res2 = await POST(badJsonReq);
    ok("body: 400 on invalid JSON", res2.status === 400);
  }

  // (6) OPTIONS preflight returns 204 + CORS headers. The extension relies
  //     on this to keep its fire-and-forget POST from being blocked.
  {
    const res = await OPTIONS();
    ok("OPTIONS: 204", res.status === 204);
    ok(
      "OPTIONS: Access-Control-Allow-Methods includes POST",
      (res.headers.get("Access-Control-Allow-Methods") || "").includes("POST"),
    );
    ok(
      "OPTIONS: Access-Control-Allow-Headers includes Authorization",
      (res.headers.get("Access-Control-Allow-Headers") || "").includes(
        "Authorization",
      ),
    );
  }

  // ============================================================
  // GET /api/admin/tekmetric-endpoint-health
  // ============================================================

  function installHealth(opts: {
    aggregateRows?: any[];
    requireThrows?: Error;
  }) {
    healthDeps.requirePlatformAdmin = (async () => {
      if (opts.requireThrows) throw opts.requireThrows;
      return {
        token: "t",
        shopId: 1,
        email: "admin@example.com",
        role: "platform_admin",
        isPlatformAdmin: true,
      } as any;
    }) as any;
    healthDeps.getDb = (async () => ({
      collection(_n: string) {
        return {
          aggregate(_pipeline: any[]) {
            return {
              toArray: async () => opts.aggregateRows ?? [],
            };
          },
        };
      },
    })) as any;
  }

  // (7) Platform-admin guard: requirePlatformAdmin throwing causes 500
  //     (the Next.js redirect path throws a NEXT_REDIRECT-style error from
  //     a non-Next context — we simulate that here as a generic throw).
  {
    installHealth({ requireThrows: new Error("Forbidden: redirect to /admin-login") });
    const res = await healthGET();
    ok("admin-guard: non-200 when requirePlatformAdmin throws", res.status === 500);
    const body = await res.json();
    ok("admin-guard: error body present", typeof body.error === "string");
  }

  // (8) Aggregation rollup math: a 100%-failing endpoint with >= 3 samples
  //     is marked `fullyFailing`; a 100%-failing endpoint with < 3 samples
  //     is NOT (avoids one-off curious-dev requests pretending to be
  //     outages); a partial-failure endpoint is not flagged.
  {
    const failingMany = {
      _id: { mosShopId: 42, smsShopId: "11", endpointShape: "/api/a" },
      total: 5,
      errors: 5,
      lastFailureAt: new Date("2026-01-02T00:00:00Z"),
      lastSuccessAt: null,
      elapsedMs: [10, 20, 30, 40, 50],
      recentStatuses: [500, 500, 500, 502, 500],
    };
    const failingFew = {
      _id: { mosShopId: 42, smsShopId: "11", endpointShape: "/api/b" },
      total: 2,
      errors: 2,
      lastFailureAt: new Date("2026-01-01T00:00:00Z"),
      lastSuccessAt: null,
      elapsedMs: [100, 200],
      recentStatuses: [500, 500],
    };
    const partial = {
      _id: { mosShopId: 42, smsShopId: "11", endpointShape: "/api/c" },
      total: 4,
      errors: 1,
      lastFailureAt: new Date("2026-01-01T00:00:00Z"),
      lastSuccessAt: new Date("2026-01-02T00:00:00Z"),
      elapsedMs: [10, 20, 30, 40],
      recentStatuses: [200, 500, 200, 200],
    };

    installHealth({ aggregateRows: [failingMany, failingFew, partial] });
    const res = await healthGET();
    ok("rollup: 200", res.status === 200);
    const body = await res.json();
    ok("rollup: lookbackDays=7", body.lookbackDays === 7);
    ok("rollup: minSamplesForFullFailure=3", body.minSamplesForFullFailure === 3);
    ok("rollup: 3 rows", Array.isArray(body.rows) && body.rows.length === 3);

    const byShape = new Map<string, any>(body.rows.map((r: any) => [r.endpointShape, r]));
    const a = byShape.get("/api/a");
    const b = byShape.get("/api/b");
    const c = byShape.get("/api/c");

    ok("rollup: /api/a errorRate = 1.0", a.errorRate === 1);
    ok(
      "rollup: /api/a fullyFailing=true (5 samples, 100%)",
      a.fullyFailing === true,
    );
    ok(
      "rollup: /api/b errorRate = 1.0 but fullyFailing=false (only 2 samples)",
      b.errorRate === 1 && b.fullyFailing === false,
    );
    ok(
      "rollup: /api/c partial failure → errorRate=0.25, fullyFailing=false",
      c.errorRate === 0.25 && c.fullyFailing === false,
    );
    ok(
      "rollup: fullyFailingCount counts only the >=3-sample row",
      body.fullyFailingCount === 1,
    );
    ok("rollup: totalRequests sums across rows", body.totalRequests === 11);
    ok("rollup: totalErrors sums across rows", body.totalErrors === 8);
    ok(
      "rollup: overallErrorRate = 8/11 (rounded to 4dp)",
      body.overallErrorRate === Number((8 / 11).toFixed(4)),
    );

    // Percentile math: median of [10,20,30,40,50] = 30, p95 = 48.
    ok("rollup: medianElapsedMs computed", a.medianElapsedMs === 30);
    ok("rollup: p95ElapsedMs computed", a.p95ElapsedMs === 48);

    // recentStatuses preserved as a small hint array.
    ok(
      "rollup: recentStatuses is a small array hint",
      Array.isArray(a.recentStatuses) && a.recentStatuses.length === 5,
    );

    // ISO date strings on the timestamps.
    ok(
      "rollup: lastFailureAt serialized as ISO string",
      typeof a.lastFailureAt === "string" && a.lastFailureAt.endsWith("Z"),
    );
    ok("rollup: lastSuccessAt null when no successes", a.lastSuccessAt === null);
  }

  // (9) Empty aggregation result → empty rollup, zeroed totals, no crash.
  {
    installHealth({ aggregateRows: [] });
    const res = await healthGET();
    ok("empty-rollup: 200", res.status === 200);
    const body = await res.json();
    ok("empty-rollup: rows=[]", Array.isArray(body.rows) && body.rows.length === 0);
    ok("empty-rollup: totalRequests=0", body.totalRequests === 0);
    ok("empty-rollup: totalErrors=0", body.totalErrors === 0);
    ok("empty-rollup: overallErrorRate=0", body.overallErrorRate === 0);
    ok("empty-rollup: fullyFailingCount=0", body.fullyFailingCount === 0);
  }

  // Restore originals for hygiene.
  Object.assign(ingestDeps, ORIGINAL_INGEST);
  Object.assign(healthDeps, ORIGINAL_HEALTH);

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
