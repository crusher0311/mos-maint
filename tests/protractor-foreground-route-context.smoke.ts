/**
 * Offline coverage for the authenticated foreground Protractor lanes.
 *
 * This deliberately reads route source instead of importing handlers: importing
 * a Next route can initialize provider clients and this test must never make a
 * production/provider request.  The shared transport test owns the runtime
 * capability semantics; this test locks the route inventory and trust-boundary
 * placement.
 */
import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (route: string) => readFileSync(join(root, route), "utf8");
const helperImport = "runWithProtractorInteractiveTransport";

// Every normal staff route that can await a live Protractor request is listed
// here.  Cached-only plan/spec routes intentionally do not appear.
const foregroundRoutes = [
  "app/api/auto-dvi/push/route.ts",
  "app/api/dashboard/concern-assistant/route.ts",
  "app/api/dashboard/protractor/canned-jobs/route.ts",
  "app/api/dashboard/protractor/contacts/route.ts",
  "app/api/dashboard/protractor/create-contact/route.ts",
  "app/api/dashboard/protractor/create-vehicle/route.ts",
  "app/api/dashboard/protractor/create-work-order/route.ts",
  "app/api/dashboard/protractor/deferred-work/route.ts",
  "app/api/dashboard/protractor/vehicles/route.ts",
  "app/api/extension/auto-dvi/push/route.ts",
  "app/api/extension/canned-jobs/route.ts",
  "app/api/extension/concern-assistant/inject-protractor/route.ts",
  "app/api/extension/jobs/add-to-ro/route.ts",
  "app/api/extension/jobs/apply-canned/route.ts",
  "app/api/extension/jobs/remove-from-ro/route.ts",
  "app/api/extension/protractor/contacts/route.ts",
  "app/api/extension/protractor/create-contact/route.ts",
  "app/api/extension/protractor/create-vehicle/route.ts",
  "app/api/extension/protractor/create-work-order/route.ts",
  "app/api/extension/protractor/deferred-work/route.ts",
  "app/api/extension/protractor/vehicles/route.ts",
  // Legacy dashboard write/read entrypoints remain staff-facing.
  "app/api/jobs/add-deferred/route.ts",
  "app/api/jobs/add-to-ro-batch/route.ts",
  "app/api/jobs/add-to-ro/route.ts",
  "app/api/plan-build/route.ts",
  "app/api/protractor/apply-canned-job/route.ts",
  "app/api/protractor/canned-jobs/route.ts",
  "app/api/protractor/inspections/route.ts",
] as const;

for (const route of foregroundRoutes) {
  const source = read(route);
  assert.match(source, /interactive-context/, `${route} must import the interactive context`);
  assert.match(source, new RegExp(`\\b${helperImport}\\s*\\(`), `${route} must establish a scope`);

  const scopeCall = source.indexOf(`${helperImport}(`);
  assert.notEqual(scopeCall, -1);
  const authBoundary = Math.max(
    source.lastIndexOf("getSession", scopeCall),
    source.lastIndexOf("cookies", scopeCall),
    source.lastIndexOf("sessions", scopeCall),
    source.lastIndexOf("guardExtensionShopRequest", scopeCall),
    source.lastIndexOf("validateExtensionToken", scopeCall),
  );
  assert.ok(authBoundary >= 0 && authBoundary < scopeCall, `${route} scopes only after auth/guard code`);
}

// Scope is always bound to a resolved server-side shop ID, never a raw query
// value.  This catches accidental capability grants to arbitrary paths/shops.
for (const route of foregroundRoutes) {
  const source = read(route);
  assert.doesNotMatch(
    source,
    new RegExp(`${helperImport}\\([\\s\\n]*\\s*(?:shopIdParam|body\\.shopId|req\\.nextUrl\\.searchParams\\.get\\("shopId"\\))`),
    `${route} must not scope a caller-supplied shop identifier`,
  );
}

// Extension canned-job refreshes have a synchronous miss lane and a detached
// stale-while-revalidate lane.  Only the awaited miss may be trusted.
const cannedJobs = read("app/api/extension/canned-jobs/route.ts");
const cannedScope = cannedJobs.indexOf(`${helperImport}(`);
assert.ok(cannedScope > cannedJobs.indexOf("async function _GET"), "foreground canned-job fetch is scoped inside the handler");
assert.ok(
  cannedJobs.indexOf("revalidateInBackground") < cannedScope,
  "background revalidation must remain outside the interactive scope",
);

// Plan-build has an internal/cache path used by pre-generation and sweeps.
// It must retain its existing non-interactive behavior; only authenticated
// session requests enter the helper.
const planBuild = read("app/api/plan-build/route.ts");
assert.match(planBuild, /trustedInternalRequest\s*\?/);
assert.match(planBuild, /trustedInternalRequest\s*\?\s*fetchProtractorVehicle/);
assert.match(planBuild, /trustedInternalRequest\s*\?\s*await fetchProtractorDeferredWork/);

// Cron, platform-admin trial, and internal route trees are intentionally
// outside this staff foreground capability.
for (const route of [
  "app/api/cron/protractor-sync/route.ts",
  "app/api/cron/protractor-stage-refresh/route.ts",
  "app/api/platform-admin/protractor-operator-stop/route.ts",
  "app/api/platform-admin/protractor-rewarm-jobs-cache-all/route.ts",
  "app/api/internal/plan-pregenerate/route.ts",
]) {
  const source = read(route);
  assert.doesNotMatch(source, /interactive-context/, `${route} must not establish foreground trust`);
}

// These staff endpoints are intentionally cache/local-data only for
// Protractor: the plan response reads normalized/cached rows and specs reads
// DataOne.  There is no live Protractor request to admit here.
for (const route of [
  "app/api/extension/plan/route.ts",
  "app/api/extension/specs/route.ts",
  "app/api/extension/tekmetric/resolve-part-costs/route.ts",
]) {
  assert.doesNotMatch(read(route), /interactive-context/, `${route} should remain cache/local-data only`);
}

console.log(`foreground Protractor route coverage passed (${foregroundRoutes.length} routes)`);