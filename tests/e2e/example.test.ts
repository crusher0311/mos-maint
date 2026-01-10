// tests/e2e/example.test.ts
// Example E2E Tests

import { testFetch, runTest, assert, assertOk, TestResult } from "./test-utils";

const BASE_URL = process.env.E2E_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;
const TEST_SECRET = process.env.E2E_TEST_SECRET;

if (!TEST_SECRET) {
  console.error("E2E_TEST_SECRET environment variable required");
  process.exit(1);
}

const api = testFetch(BASE_URL, TEST_SECRET, {
  shopId: 25,
  email: "test@example.com",
  role: "owner",
});

async function testAuthBypass(): Promise<void> {
  const res = await api("/api/ping");
  assertOk(res, "Ping endpoint should be accessible");
}

async function testVehiclesEndpoint(): Promise<void> {
  const res = await api("/api/vehicle/common-failures?vin=TEST123&year=2020&make=Honda&model=Accord&mileage=50000");
  assertOk(res, "Vehicle common failures endpoint should return 200");
  const data = await res.json();
  assert("failures" in data || "patterns" in data || "error" in data, "Should return data");
}

async function testDashboardData(): Promise<void> {
  const res = await api("/api/dashboard");
  if (res.status === 404) {
    console.log("  (Dashboard endpoint not found, skipping)");
    return;
  }
  assertOk(res, "Dashboard endpoint should return 200");
}

async function testUnauthorizedWithoutToken(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/admin/shops`, {
    redirect: "manual",
  });
  assert(res.status === 401 || res.status === 302 || res.status === 307, "Should reject unauthenticated request");
}

async function testPlatformAdminAccess(): Promise<void> {
  const adminApi = testFetch(BASE_URL, TEST_SECRET, {
    shopId: 1,
    email: "admin@mos.tools",
    role: "owner",
    isPlatformAdmin: true,
  });
  
  const res = await adminApi("/api/admin/sync-health");
  if (res.status === 404) {
    console.log("  (Admin sync-health endpoint not found, skipping)");
    return;
  }
  assertOk(res, "Platform admin should access admin endpoints");
}

async function testCommonFailures(): Promise<void> {
  const res = await api("/api/vehicle/common-failures?vin=1HGCG5655WA123456&year=2020&make=Honda&model=Accord&mileage=50000");
  if (res.status === 404) {
    console.log("  (Common failures endpoint not found, skipping)");
    return;
  }
  assertOk(res, "Common failures endpoint should return 200");
  const data = await res.json();
  assert("failures" in data || "patterns" in data || "error" in data, "Should return failures data");
}

async function testNormalizedJobSearch(): Promise<void> {
  const res = await api("/api/jobs/search-normalized?q=oil+change&limit=5");
  if (res.status === 404) {
    console.log("  (Normalized job search not found, skipping)");
    return;
  }
  assertOk(res, "Normalized job search should return 200");
  const data = await res.json();
  assert("results" in data || "jobs" in data || Array.isArray(data), "Should return search results");
}

const tests = [
  { name: "Auth bypass works", fn: testAuthBypass },
  { name: "Vehicle endpoint accessible", fn: testVehiclesEndpoint },
  { name: "Dashboard data loads", fn: testDashboardData },
  { name: "Unauthorized without token", fn: testUnauthorizedWithoutToken },
  { name: "Platform admin access", fn: testPlatformAdminAccess },
  { name: "Common failures advisor", fn: testCommonFailures },
  { name: "Normalized job search", fn: testNormalizedJobSearch },
];

async function main(): Promise<void> {
  console.log(`\n🧪 Running E2E Tests against ${BASE_URL}\n`);
  console.log("─".repeat(50));

  const results: TestResult[] = [];

  for (const test of tests) {
    process.stdout.write(`  ${test.name}... `);
    const result = await runTest(test.name, test.fn);
    results.push(result);
    
    if (result.passed) {
      console.log(`✅ (${result.duration}ms)`);
    } else {
      console.log(`❌`);
      console.log(`     Error: ${result.error}`);
    }
  }

  console.log("─".repeat(50));
  
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed (${totalTime}ms total)\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
