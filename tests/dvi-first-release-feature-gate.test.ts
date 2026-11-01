import test from "node:test";
import assert from "node:assert/strict";
const Module = require("module"), original = Module._load;
let dvi = false, workflow = true, maintenance = true, cacheReads = 0, claims = 0, scans = 0, revokeDuringRead = false;
Module._load = function(id: string, ...args: any[]) {
  if (id.endsWith("/auth")) return {getSession: async () => ({shopId: 66, email: "fixture@example.test"})};
  if (id.endsWith("featureResolver")) return {getFeatureEntitlements: async () => ({
    isFeatureEnabled: (feature: string) => feature === "auto_dvi" ? dvi : feature === "shop_workflow" ? workflow : maintenance,
  })};
  if (id.endsWith("staff/check-in-access")) return {checkInAccess: async () => ({shopId: 66, actor: "fixture"})};
  if (id.endsWith("/data/db")) return {getDb: async () => ({})};
  if (id.endsWith("/plan-cache")) return {getCachedPlan: async () => {
    cacheReads++; if (revokeDuringRead) dvi = false;
    return {plan: {buckets: {overdue: [], dueSoon: []}}};
  }};
  if (id.endsWith("/staff/access") || id === "./access") return {
    staffAccess: async () => {throw Error("Unexpected access");},
    staffMemberAccess: async () => {throw Error("Unexpected worker access");},
  };
  if (id === "./runtime") return {staffDependencies: {}};
  if (id === "./recording-store") return {
    MongoRecordingPersistence: class {async pending() {scans++; return [];}},
    RecordingRepository: class {},
  };
  if (id === "./recording-media") return {RecordingMediaStorage: class {}};
  if (id === "./recording-processor" || id === "./recording-worker" || id === "./recording-clip-worker") return {};
  if (id.endsWith("intake-preparation")) return {IntakePreparation: class {
    async processOne() {claims++; return false;}
    async request() {throw Error("Unexpected enqueue");}
  }};
  if (id.endsWith("/data/repositories/shops")) return {};
  if (id.endsWith("/vhi-rebuild")) return {};
  return original.call(this, id, ...args);
};
const route = require("../app/api/dashboard/protractor/intake-context/route");
const {prepareOneIntakeContext} = require("../lib/auto-dvi/staff/intake-preparation-worker");
const {dispatchRecordingPass} = require("../lib/auto-dvi/staff/recording-dispatch");
Module._load = original;
function request() {return new Request("https://fixture.invalid/api/dashboard/protractor/intake-context", {
  method: "POST", headers: {origin: "https://fixture.invalid", host: "fixture.invalid", "Content-Type": "application/json"},
  body: JSON.stringify({vin: "1HGCM82633A004352", mileage: 10000, distanceUnit: "miles"}),
});}
test("DVI-off intake is denied before cached reads; fresh revocation cannot return context", async () => {
  assert.equal((await route.POST(request())).status, 403);
  assert.equal(cacheReads, 0);
  dvi = true;
  assert.equal((await route.POST(request())).status, 200);
  assert.equal(cacheReads, 1);
  revokeDuringRead = true;
  assert.equal((await route.POST(request())).status, 403);
  revokeDuringRead = false;
  dvi = true; maintenance = false;
  assert.equal((await route.POST(request())).status, 403);
  assert.equal(cacheReads, 2);
  maintenance = true;
});
test("explicit worker enrollment never overrides DVI-off or consumes queued attempts", async () => {
  dvi = false;
  assert.equal(await prepareOneIntakeContext(66), false);
  assert.deepEqual(await dispatchRecordingPass([66]), {processed: 0, blocked: 0});
  assert.equal(claims, 0); assert.equal(scans, 0);
  dvi = true; workflow = false;
  await dispatchRecordingPass([66]); await prepareOneIntakeContext(66);
  assert.equal(claims, 0); assert.equal(scans, 0);
  workflow = true;
  await dispatchRecordingPass([66]);
  assert.equal(claims, 1); assert.equal(scans, 1);
});
