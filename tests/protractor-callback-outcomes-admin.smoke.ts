/**
 * Offline coverage for the platform-admin callback outcome surface.
 *
 * Run:
 *   NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
 *     npx tsx tests/protractor-callback-outcomes-admin.smoke.ts
 *
 * The route test replaces both auth and the repository before importing the
 * route. No Mongo, Postgres, provider, queue, or worker code is called.
 * Repository projection/bound assertions live in
 * `protractor-callback-outcomes-repository.smoke.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";

type Report = {
  sampleLimit: 200;
  windowHours: 24;
  sampled: number;
  counts: Record<string, number>;
  rows: Array<{
    shopId: number;
    method: "GET" | "POST";
    receivedAt: string | null;
    category: string;
    reason: string;
    indexedJobs?: number;
    changedJobs?: number;
  }>;
};

const originalLoad = (Module as any)._load;
let requirePlatformAdminCalls = 0;
let reportCalls = 0;
let authorized = false;
let failReport = false;

const report: Report = {
  sampleLimit: 200,
  windowHours: 24,
  sampled: 1,
  counts: { applied_indexed: 1 },
  rows: [
    {
      method: "POST",
      shopId: 42,
      receivedAt: "2026-08-22T12:00:00.000Z",
      category: "applied_indexed",
      reason: "indexed",
      indexedJobs: 2,
      changedJobs: 0,
    },
  ],
};

function moduleRequestMatches(request: string, suffix: string): boolean {
  return request === suffix || request.endsWith(suffix);
}

(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (moduleRequestMatches(request, "@/lib/auth") || moduleRequestMatches(request, "/lib/auth")) {
    return {
      requirePlatformAdmin: async () => {
        requirePlatformAdminCalls += 1;
        if (!authorized) {
          const redirectError: any = new Error("redirected");
          redirectError.digest = "NEXT_REDIRECT;replace;/admin-login";
          throw redirectError;
        }
        return { isPlatformAdmin: true };
      },
    };
  }
  if (
    moduleRequestMatches(
      request,
      "@/lib/data/repositories/protractor-callback-events",
    ) ||
    moduleRequestMatches(
      request,
      "/lib/data/repositories/protractor-callback-events",
    )
  ) {
    return {
      getCallbackOutcomeReport: async () => {
        reportCalls += 1;
        if (failReport) throw new Error("private customer/VIN/query details");
        return report;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function testRouteAuthAndResponse() {
  const { GET } = await import(
    "../app/api/admin/sync-health/protractor-callback-outcomes/route"
  );

  authorized = false;
  await assert.rejects(
    () => GET(),
    (error: any) => String(error?.digest).startsWith("NEXT_REDIRECT"),
    "unauthorized requests preserve the platform-admin redirect",
  );
  assert.equal(requirePlatformAdminCalls, 1);
  assert.equal(
    reportCalls,
    0,
    "the repository is not touched when platform-admin auth denies",
  );

  authorized = true;
  const response = await GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, report);
  assert.equal(requirePlatformAdminCalls, 2);
  assert.equal(reportCalls, 1);

  assert.equal(body.sampleLimit, 200);
  assert.equal(body.windowHours, 24);
  assert.ok(body.sampled <= body.sampleLimit);
  assert.ok(body.rows.length <= body.sampleLimit);
  assert.deepEqual(Object.keys(body.rows[0]).sort(), [
    "category",
    "changedJobs",
    "indexedJobs",
    "method",
    "reason",
    "receivedAt",
    "shopId",
  ]);
  const serialized = JSON.stringify(body);
  for (const forbidden of ["payload", "vin", "customer", "providerId", "connectionId"]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `response does not expose ${forbidden}`,
    );
  }
  failReport = true;
  const failed = await GET();
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "Failed to load callback outcome report" });
  failReport = false;
}

function testUiContract() {
  const source = readFileSync(
    "app/platform-admin/sync-health/page.tsx",
    "utf8",
  );
  const start = source.indexOf("function ProtractorCallbackOutcomeSection()");
  const end = source.indexOf("export default function SyncHealthPage()");
  assert.ok(start >= 0 && end > start, "focused callback outcome component exists");
  const component = source.slice(start, end);

  assert.match(component, /onClick=\{load\}/);
  assert.match(component, /protractor-callback-outcomes/);
  assert.match(component, /sample counts, not fleet totals/);
  assert.match(component, /hash-verified/);
  assert.match(component, /Legacy unknown/);
  assert.match(component, /Indexed jobs/);
  assert.match(component, /Changed jobs/);
  assert.doesNotMatch(component, /VIN|Customer|Provider ID|connection ID/i);
  assert.match(
    source,
    /<ProtractorCallbackOutcomeSection \/>/,
    "focused component is integrated into the sync-health page",
  );
}

async function main() {
  await testRouteAuthAndResponse();
  testUiContract();
  console.log("✓ callback outcome admin API/UI offline tests passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    (Module as any)._load = originalLoad;
  });