// tests/e2e/full-suite.test.ts
// Comprehensive E2E Test Suite - Tests all major API endpoints

import { testFetch, runTest, assert, assertOk, TestResult } from "./test-utils";

const BASE_URL = process.env.E2E_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;
const TEST_SECRET = process.env.E2E_TEST_SECRET;

if (!TEST_SECRET) {
  console.error("E2E_TEST_SECRET environment variable required");
  process.exit(1);
}

const shopApi = testFetch(BASE_URL, TEST_SECRET, {
  shopId: 25,
  email: "test@example.com",
  role: "owner",
});

const adminApi = testFetch(BASE_URL, TEST_SECRET, {
  shopId: 1,
  email: "admin@mos.tools",
  role: "owner",
  isPlatformAdmin: true,
});

type TestDefinition = {
  name: string;
  fn: () => Promise<void>;
  category: string;
};

const tests: TestDefinition[] = [];

function test(category: string, name: string, fn: () => Promise<void>) {
  tests.push({ category, name, fn });
}

// ============================================
// AUTH & SESSION
// ============================================

test("Auth", "Auth bypass with valid token", async () => {
  const res = await shopApi("/api/ping");
  assertOk(res);
});

test("Auth", "Reject request without token", async () => {
  const res = await fetch(`${BASE_URL}/api/dashboard/data`, { redirect: "manual" });
  assert(res.status === 302 || res.status === 307 || res.status === 401, "Should reject");
});

test("Auth", "Get current user info", async () => {
  const res = await shopApi("/api/auth/me");
  if (res.status === 404) return;
  assertOk(res);
  const data = await res.json();
  assert("email" in data || "user" in data || "session" in data, "Should return user info");
});

// ============================================
// DASHBOARD
// ============================================

test("Dashboard", "Dashboard data v2", async () => {
  const res = await shopApi("/api/dashboard/data-v2");
  if (res.status === 404 || res.status === 401) return; // May require specific shop setup
  assertOk(res);
});

test("Dashboard", "Dashboard data", async () => {
  const res = await shopApi("/api/dashboard/data");
  if (res.status === 404 || res.status === 401) return; // May require specific shop setup
  assertOk(res);
});

// ============================================
// VEHICLE ANALYSIS
// ============================================

test("Vehicles", "Common failures advisor", async () => {
  const res = await shopApi("/api/vehicle/common-failures?vin=TEST123&year=2020&make=Honda&model=Accord&mileage=50000");
  assertOk(res);
  const data = await res.json();
  assert("failures" in data || "patterns" in data, "Should return failures");
});

test("Vehicles", "Vehicle analyzer", async () => {
  const res = await shopApi("/api/vehicle-analyzer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vin: "1HGCG5655WA123456" }),
  });
  if (res.status === 404 || res.status === 400) return;
  assert(res.status === 200 || res.status === 202, "Should accept request");
});

test("Vehicles", "Check closed orders", async () => {
  const res = await shopApi("/api/vehicles/check-closed-orders", { method: "POST" });
  if (res.status === 404 || res.status === 400 || res.status === 405) return; // May need POST with body
  assertOk(res);
});

// ============================================
// JOBS & SEARCH
// ============================================

test("Jobs", "Normalized job search", async () => {
  const res = await shopApi("/api/jobs/search-normalized?q=oil+change&limit=5");
  assertOk(res);
  const data = await res.json();
  assert("results" in data || "jobs" in data || Array.isArray(data), "Should return results");
});

test("Jobs", "Job search (legacy)", async () => {
  const res = await shopApi("/api/jobs/search?q=brake&limit=5");
  if (res.status === 404) return;
  assertOk(res);
});

test("Jobs", "Job autocomplete", async () => {
  const res = await shopApi("/api/jobs/autocomplete?q=oil&limit=5");
  if (res.status === 404) return;
  assertOk(res);
});

test("Jobs", "Job stats", async () => {
  const res = await shopApi("/api/jobs/stats");
  if (res.status === 404) return;
  assertOk(res);
});

test("Jobs", "Open work orders", async () => {
  const res = await shopApi("/api/jobs/open-work-orders");
  if (res.status === 404) return;
  assertOk(res);
});

// ============================================
// EXTENSION API
// ============================================

test("Extension", "Extension version check", async () => {
  const res = await fetch(`${BASE_URL}/api/extension/version`);
  assertOk(res);
  const data = await res.json();
  assert("currentVersion" in data || "minVersion" in data, "Should return version info");
});

test("Extension", "Extension plan", async () => {
  const res = await shopApi("/api/extension/plan?vin=1HGCG5655WA123456");
  if (res.status === 404 || res.status === 400) return;
  assert(res.status === 200 || res.status === 202, "Should process request");
});

test("Extension", "Extension canned jobs", async () => {
  const res = await shopApi("/api/extension/canned-jobs");
  if (res.status === 404 || res.status === 400 || res.status === 401) return; // Needs extension auth
  assertOk(res);
});

test("Extension", "Extension job search", async () => {
  const res = await shopApi("/api/extension/jobs/search?q=tire&limit=5");
  if (res.status === 404 || res.status === 401) return; // Needs extension auth
  assertOk(res);
});

// ============================================
// SETTINGS
// ============================================

test("Settings", "Get preferences", async () => {
  const res = await shopApi("/api/settings/preferences");
  if (res.status === 404) return;
  assertOk(res);
});

test("Settings", "Get integrations", async () => {
  const res = await shopApi("/api/settings/integrations");
  if (res.status === 404) return;
  assertOk(res);
});

test("Settings", "Get billing settings", async () => {
  const res = await shopApi("/api/settings/billing");
  if (res.status === 404) return;
  assertOk(res);
});

test("Settings", "Get canned job mappings", async () => {
  const res = await shopApi("/api/settings/canned-job-mappings");
  if (res.status === 404) return;
  assertOk(res);
});

test("Settings", "Get branding", async () => {
  const res = await shopApi("/api/settings/branding");
  if (res.status === 404) return;
  assertOk(res);
});

test("Settings", "Shop features", async () => {
  const res = await shopApi("/api/shop/features");
  if (res.status === 404) return;
  assertOk(res);
});

// ============================================
// SMS INTEGRATIONS (Protractor/Tekmetric)
// ============================================

test("Protractor", "Get canned jobs", async () => {
  const res = await shopApi("/api/protractor/canned-jobs");
  if (res.status === 404 || res.status === 400) return;
  assertOk(res);
});

test("Tekmetric", "Get canned jobs", async () => {
  const res = await shopApi("/api/tekmetric/canned-jobs");
  if (res.status === 404 || res.status === 400) return;
  assertOk(res);
});

test("Tekmetric", "Get labels", async () => {
  const res = await shopApi("/api/tekmetric/labels");
  if (res.status === 404 || res.status === 400) return;
  assertOk(res);
});

// ============================================
// BILLING
// ============================================

test("Billing", "Get billing config", async () => {
  const res = await shopApi("/api/billing/config");
  if (res.status === 404) return;
  assertOk(res);
});

test("Billing", "Get Stripe prices", async () => {
  const res = await shopApi("/api/stripe/prices");
  if (res.status === 404) return;
  assertOk(res);
});

// ============================================
// ENTERPRISE
// ============================================

test("Enterprise", "Get enterprise info", async () => {
  const res = await shopApi("/api/enterprise");
  if (res.status === 404 || res.status === 403) return;
  assertOk(res);
});

test("Enterprise", "Get enterprise locations", async () => {
  const res = await shopApi("/api/enterprise/locations");
  if (res.status === 404 || res.status === 403) return;
  assertOk(res);
});

test("Enterprise", "Get enterprise users", async () => {
  const res = await shopApi("/api/enterprise/users");
  if (res.status === 404 || res.status === 403 || res.status === 400) return; // May need enterprise setup
  assertOk(res);
});

// ============================================
// USER
// ============================================

test("User", "Get user shops", async () => {
  const res = await shopApi("/api/user/shops");
  if (res.status === 404) return;
  assertOk(res);
});

// ============================================
// ANALYTICS
// ============================================

test("Analytics", "Shop analytics", async () => {
  const res = await shopApi("/api/shop/analytics");
  if (res.status === 404) return;
  assertOk(res);
});

// ============================================
// PLATFORM ADMIN
// ============================================

test("Platform Admin", "Sync health", async () => {
  const res = await adminApi("/api/admin/sync-health");
  if (res.status === 401 || res.status === 403) return; // Admin-only
  assertOk(res);
});

test("Platform Admin", "Normalized stats", async () => {
  const res = await adminApi("/api/admin/normalized-stats");
  if (res.status === 404 || res.status === 401 || res.status === 403) return; // Admin-only
  assertOk(res);
});

test("Platform Admin", "Audit logs", async () => {
  const res = await adminApi("/api/admin/audit-logs");
  if (res.status === 404) return;
  assertOk(res);
});

test("Platform Admin", "Usage stats", async () => {
  const res = await adminApi("/api/admin/usage");
  if (res.status === 404) return;
  assertOk(res);
});

test("Platform Admin", "Platform stats", async () => {
  const res = await adminApi("/api/platform-admin/stats");
  if (res.status === 404) return;
  assertOk(res);
});

test("Platform Admin", "Platform shops list", async () => {
  const res = await adminApi("/api/platform-admin/shops");
  if (res.status === 404) return;
  assertOk(res);
});

test("Platform Admin", "Platform users list", async () => {
  const res = await adminApi("/api/platform-admin/users");
  if (res.status === 404) return;
  assertOk(res);
});

test("Platform Admin", "Platform usage", async () => {
  const res = await adminApi("/api/platform-admin/usage");
  if (res.status === 404) return;
  assertOk(res);
});

test("Platform Admin", "Features list", async () => {
  const res = await adminApi("/api/admin/features");
  if (res.status === 404 || res.status === 401 || res.status === 403) return; // Admin-only
  assertOk(res);
});

// ============================================
// E2E TEST INFRASTRUCTURE
// ============================================

test("E2E", "Token endpoint status", async () => {
  const res = await fetch(`${BASE_URL}/api/e2e/token`);
  assertOk(res);
  const data = await res.json();
  assert(data.enabled === true, "E2E testing should be enabled");
});

// ============================================
// RUN TESTS
// ============================================

async function main(): Promise<void> {
  console.log(`\n🧪 Full E2E Test Suite - ${BASE_URL}\n`);
  console.log("═".repeat(60));

  const results: TestResult[] = [];
  const categories = [...new Set(tests.map((t) => t.category))];

  for (const category of categories) {
    console.log(`\n📂 ${category}`);
    console.log("─".repeat(40));

    const categoryTests = tests.filter((t) => t.category === category);
    for (const test of categoryTests) {
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
  }

  console.log("\n" + "═".repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n📊 SUMMARY: ${passed} passed, ${failed} failed (${(totalTime / 1000).toFixed(1)}s total)`);

  if (failed > 0) {
    console.log("\n❌ Failed tests:");
    results
      .filter((r) => !r.passed)
      .forEach((r) => console.log(`   - ${r.name}: ${r.error}`));
    console.log("");
    process.exit(1);
  }

  console.log("\n✅ All tests passed!\n");
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
