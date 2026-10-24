import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import fs from "node:fs";
import { NextRequest } from "next/server";
import { projectPublicReport, validCustomerMileage } from "../lib/public-report-mileage";

const vin = "1HGCM82633A004352";
const day = new Date("2026-10-08T12:00:00Z");
const base: any = {
  currentMiles: 50000, distanceUnit: "miles", customerName: "Fixture",
  vehicle: {}, buckets: { overdue: [], dueSoon: [], upcoming: [
    { key: "oil", dueAtMiles: 50100, milesToGo: 100, dueAtDate: null },
    { key: "date", dueAtDate: "2026-10-07", milesToGo: null },
  ] },
};
const projected = projectPublicReport(base, "2026-10-01", null, null, day);
assert.equal(projected.currentMiles, 50230);
assert.equal(projected.buckets.overdue.length, 2);
assert.equal(base.buckets.upcoming[0].milesToGo, 100, "projection must not mutate cache");
assert.equal(projectPublicReport(base, "2026-10-01", null, 51000, day).currentMiles, 51000);
assert.equal(projectPublicReport(base, "2026-10-01", null, 40000, day).currentMiles, 50230, "lower CARFAX estimate uses annual fallback");
assert.equal(projectPublicReport(base, "2026-10-09", null, null, day).currentMiles, 50000, "never project backwards");
const anchor = { mileage: 60000, recordedAt: day, source: "customer_entered" as const, distanceUnit: "miles" as const };
const entered = projectPublicReport(base, "2026-10-01", anchor, 70000, day);
assert.equal(entered.currentMiles, 60000, "today's accepted actual anchor beats predictions");
assert.equal(entered.mileageInputSource, "customer_entered");
assert.equal(entered.mileageEstimated, false);
assert.equal(projectPublicReport(base, "2026-10-01", anchor, null, new Date("2026-10-09")).currentMiles, 60033);
assert.equal(projectPublicReport({ ...base, distanceUnit: "kilometers" }, "2026-10-01", null, null, day).currentMiles, 50371);
const metricCarfax = projectPublicReport({ ...base, distanceUnit: "kilometers" }, "2026-10-01", null, 40000, day);
assert.equal(metricCarfax.currentMiles, 64374, "40,000 CARFAX miles must exceed a 50,000 km reading");
assert.equal(metricCarfax.mileageSource, "estimated_carfax");
for (const bad of [0, 100, -1, 1_000_000, NaN, Infinity, 123.4, "50000", null]) assert.equal(validCustomerMileage(bad), false);
assert.ok(validCustomerMileage(101) && validCustomerMileage(999999));

const Module = require("module");
const originalLoad = Module._load;
let state: any = null;
let cached: any = { plan: structuredClone(base), mileage: 50000, createdAt: new Date(Date.now() - 2 * 86400000) };
let rateAllowed = true;
let entitled = true;
let roMileage = 0;
let pendingBuild: (() => void) | null = null;
const builds: any[][] = [];
const limits: any[] = [];
const db = { collection(name: string) {
  return {
    async createIndex() { return "pending_public_mileage_refresh"; },
    async findOne(filter: any) {
      if (name === "public_report_state" && filter.pendingMileageRevision) {
        return state?.pendingMileageRevision && (!state.refreshAfter || state.refreshAfter <= new Date()) ? state : null;
      }
      if (name === "public_report_state") return state;
      if (name === "shops") return { shopId: 42, name: "Offline Shop", integrationProvider: "tekmetric" };
      if (name === "vehicles") return { currentMileage: 50000 };
      if (name === "tekmetric_work_orders") return roMileage ? { odometer: roMileage } : null;
      return null;
    },
    async updateOne(filter: any, update: any) {
      if (update.$unset) {
        if (state?.pendingMileageRevision !== filter.pendingMileageRevision) return { matchedCount: 0 };
        delete state.pendingMileageRevision;
        return { matchedCount: 1 };
      }
      const cooldown = filter.$or[1]?.refreshAfter?.$lte;
      const mileage = filter.$or[1]?.["customerMileage.mileage"]?.$lte;
      const denied = state && ((cooldown && state.refreshAfter > cooldown) ||
        (mileage != null && state.customerMileage?.mileage > mileage));
      if (denied) throw Object.assign(new Error("duplicate key"), { code: 11000 });
      const existed = !!state;
      state = { ...state, ...update.$set };
      return { matchedCount: existed ? 1 : 0, modifiedCount: existed ? 1 : 0, upsertedCount: existed ? 0 : 1 };
    },
  };
} };
const mocks: Record<string, any> = {
  "@/lib/mongo": { getDb: async () => db },
  "@/lib/auth": { getSession: async () => null },
  "@/lib/report-share": {
    verifyShareToken: (token: string) => token === "valid" ? { vin, shopId: "42" } : token === "wrong-vin" ? { vin: "1HGCM82633A004353", shopId: "42" } : null,
  },
  "@/lib/featureResolver": { getFeatureEntitlements: async () => ({ canUseFeature: () => entitled, effectiveFeatures: {} }) },
  "@/lib/rate": { rateLimit: async (opts: any) => { limits.push(opts); return { allowed: rateAllowed }; } },
  "@/lib/vhi-rebuild": { triggerPlanBuild: async (...args: any[]) => {
    builds.push(args);
    await new Promise<void>(resolve => { pendingBuild = resolve; });
    return { ok: true, plan: { ...base, currentMiles: args[2] } };
  } },
  "@/lib/integrations/carfax": { estimateMileageFromCarfax: async () => ({ estimated: false, mileage: null }) },
  "@/lib/data/repositories/plan-cache-store": {
    findLatestCachedPlanDoc: async () => cached,
    getReportApprovedItemsDoc: async () => null,
    findCachedWorkOrderCustomerName: async () => null,
    getMaintenanceAnalysisDoc: async () => null,
  },
  "@/lib/data/repositories/tekmetric-work-orders": { findLatestTekmetricWorkOrderByVinWithCustomerName: async () => null },
  "@/lib/data/repositories/auto-dvi": { readInspectionResults: async () => null },
  "@/lib/shop-feature-access": { canAccessShopFeature: () => true },
};
Module._load = function(request: string, ...rest: any[]) {
  return Object.hasOwn(mocks, request) ? mocks[request] : originalLoad.call(this, request, ...rest);
};

async function main() {
  const { GET } = require("../app/api/report/[vin]/route");
  const { POST } = require("../app/api/report/[vin]/mileage/route");
  const service = require("../lib/public-report-service");
  const context = { params: { vin } };
  const read = (token = "valid") => GET(new NextRequest(`https://example.test/api/report/${vin}?token=${token}`), context);
  const write = (mileage: any, token = "valid", origin?: string) => POST(new NextRequest(`https://example.test/api/report/${vin}/mileage?token=${token}`, {
    method: "POST", body: JSON.stringify({ mileage }), headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
  }), context);

  const response = await read();
  assert.equal(response.status, 200, "stale read returns while build is still pending");
  assert.match(response.headers.get("cache-control")!, /no-store/);
  const report = await response.json();
  assert.ok(report.plan.currentMiles > 50000);
  assert.equal(builds.length, 1);
  assert.equal(builds[0][4], true, "every refresh passes skipCarfax=true");
  assert.equal(builds[0][7], 20000, "upstream build has a deadline");
  await read();
  assert.equal(builds.length, 1, "concurrent/stale visitors cannot start another build");
  pendingBuild!();
  await new Promise(resolve => setImmediate(resolve));
  await read();
  assert.equal(builds.length, 1, "completion does not clear cooldown");
  assert.equal((await read("expired")).status, 403);
  assert.equal((await read("wrong-vin")).status, 403);
  entitled = false;
  assert.equal((await write(60000)).status, 403);
  entitled = true;
  assert.equal((await write(60000, "expired")).status, 403);
  assert.equal((await write(60000, "valid", "https://attacker.test")).status, 403);
  assert.equal((await write(100)).status, 400);
  assert.equal((await write("60000")).status, 400);
  assert.equal((await write(49000)).status, 409);
  roMileage = 65000;
  assert.equal((await write(60000)).status, 409, "known RO is a floor");
  roMileage = 0;
  assert.equal((await write(60000)).status, 200);
  assert.equal(state.customerMileage.source, "customer_entered");
  assert.equal(state.customerMileage.distanceUnit, "miles");
  assert.ok(state.customerMileage.recordedAt instanceof Date);
  assert.equal((await (await read()).json()).plan.currentMiles, 60000, "accepted reading immediately overlays stale plan");
  assert.equal((await write(59999)).status, 409);
  const saved = await Promise.all([
    service.saveCustomerMileage(db, 42, vin, { ...anchor, mileage: 62000 }),
    service.saveCustomerMileage(db, 42, vin, { ...anchor, mileage: 61000 }),
  ]);
  assert.deepEqual(saved, [true, false], "CAS rejects racing lower submission");
  rateAllowed = false;
  assert.equal((await write(70000)).status, 429);
  assert.ok(limits.some(l => l.id.startsWith("public-mileage:vehicle:") && l.limit === 5));
  assert.ok(limits.some(l => l.id.startsWith("public-mileage:ip:") && l.limit === 20));
  state = null;
  cached = { ...cached, createdAt: new Date() };
  await read();
  assert.equal(builds.length, 1, "fresh cached plans do not rebuild");

  // First visit: a 202 keeps the page polling, then the real report appears.
  cached = null;
  assert.equal((await read()).status, 202);
  // Refresh is detached from the response; allow repository awaits to settle.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(builds.length, 2);
  cached = { plan: structuredClone(base), createdAt: new Date() };
  pendingBuild!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await read()).status, 200);
  const page = fs.readFileSync("app/report/[vin]/page.tsx", "utf8");
  assert.match(page, /res.status === 202/);
  assert.match(page, /setTimeout\(load, 3000\)/);
  assert.match(page, /attempts >= 40/);

  // A stale build in flight must not consume a later mileage request.
  state = null;
  cached.createdAt = new Date(Date.now() - 2 * 86400000);
  await read();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(builds.length, 3);
  rateAllowed = true;
  assert.equal((await write(70000)).status, 200);
  const revision = state.pendingMileageRevision;
  assert.ok(revision);
  assert.equal(builds.length, 3, "submitted mileage respects existing lease");
  // Earlier build lands AFTER submission with old mileage and a fresh timestamp.
  cached = { plan: structuredClone(base), createdAt: new Date() };
  pendingBuild!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.pendingMileageRevision, revision);
  assert.equal(await service.drainPublicMileageRefresh(), false, "cron respects lease");
  state.refreshAfter = new Date(0);
  const drain = service.drainPublicMileageRefresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(builds.length, 4, "durable pending request bypasses fresh-cache age gate");
  assert.equal(builds[3][2], 70000);
  assert.equal(builds[3][4], true);
  assert.equal(builds[3][8], true, "queued mileage must force an actual plan rebuild");
  // A second submission racing with completion must not be erased.
  await service.saveCustomerMileage(db, 42, vin, { ...anchor, mileage: 71000 });
  const newerRevision = state.pendingMileageRevision;
  pendingBuild!();
  assert.equal(await drain, true);
  assert.equal(state.pendingMileageRevision, newerRevision);
  state.refreshAfter = new Date(0);
  const nextDrain = service.drainPublicMileageRefresh();
  await new Promise(resolve => setImmediate(resolve));
  pendingBuild!();
  assert.equal(await nextDrain, true);
  assert.equal(state.pendingMileageRevision, undefined);

  // Exercise the real cache selector plus the real plan-build reuse gate.
  const { selectValidCachedPlan, PLAN_CACHE_SCHEMA_VERSION, canReusePlanForBuild } = require("../lib/plan-cache");
  const freshEntry = {
    vin, shopId: 42, mileage: 50000, plan: structuredClone(base),
    createdAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() + 4 * 3600000),
    schemaVersion: PLAN_CACHE_SCHEMA_VERSION,
  };
  const hit = selectValidCachedPlan([freshEntry], { vin, currentMiles: 50100 });
  assert.ok(hit, "real cache selector accepts the 100-mile increase");
  assert.equal(canReusePlanForBuild(hit, { trustedInternal: true, forceRebuild: true }), false);
  assert.equal(canReusePlanForBuild(hit, { trustedInternal: false, forceRebuild: true }), true, "untrusted callers cannot force a rebuild");
  assert.equal(canReusePlanForBuild(hit, { trustedInternal: true, forceRebuild: false }), true);
  state = null;
  cached = freshEntry;
  const smallUpdate = await write(50100);
  assert.equal(smallUpdate.status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(builds.at(-1)![2], 50100);
  assert.equal(builds.at(-1)![8], true, "small customer update passes forced rebuild to plan-build");
  pendingBuild!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.pendingMileageRevision, undefined, "small successful rebuild drains the pending revision");

  // Guard the paid-lookup boundary and anchor wiring in the shared build handler.
  const source = fs.readFileSync("app/api/plan-build/route.ts", "utf8");
  assert.match(source, /const carfaxFetch = skipCarfax\s*\? fetchCarfaxCacheOnly/);
  assert.match(source, /readCustomerMileage\(db, shopId, vin\)/);
  assert.match(source, /customerMileage\.mileage >= mileage/);
  assert.match(source, /mileageInputSource: "customer_entered"/);
  assert.match(source, /canReusePlanForBuild\(existingCache/);
  console.log("Public report mileage: projection, stale-serve, cache-only refresh, authorization, monotonicity, provenance and rate limits passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Module._load = originalLoad; });
