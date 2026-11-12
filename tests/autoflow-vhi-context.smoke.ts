import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { __deps, findAutoflowInteractiveShop, findShopBySmsId } from "../lib/extension-shop-lookup";
import { requireExtensionPrincipalScope, getUserShopIds, getAuthErrorStatus, buildAuthErrorBody } from "../lib/extension-auth";
import { makeFakeDb } from "./utils/fake-mongo";

const vin = "1HGCM82633A004352";
const owner = { shopId: 33, integrationProvider: "protractor",
  protractor: { connectionId: "fixture-connection" },
  autoflowDomain: "fixture.autotext.me", autoflow: { shopNumbers: ["743", 744] } };
let fake = makeFakeDb({});
let auth: any;
let historyReads = 0;
let failLookup = false;
__deps.getDb = async () => {
  if (failLookup) throw new Error("offline lookup failure");
  return fake.db as any;
};
__deps.getMongoClient = async () => { throw new Error("No mapping writes allowed"); };
const source = fs.readFileSync("app/api/extension/plan/route-handler.ts", "utf8");
const sandbox: any = {
  console: { log() {}, warn() {}, error() {} }, Date,
  findAutoflowInteractiveShop, findShopBySmsId,
  validateExtensionToken: async () => auth,
  getUserShopIds, requireExtensionPrincipalScope, getAuthErrorStatus, buildAuthErrorBody,
  getDb: async () => fake.db,
  NextResponse: { json: (body: any, opts: any = {}) => ({ body, status: opts.status || 200 }) },
  corsHeaders: {}, checkShopFeatureGate: async () => null,
  canReadNativeTekmetricRo: (provider: string, anchored: boolean) => provider === "tekmetric" && !anchored,
  estimateMileageFromCarfax: async () => ({ estimated: false }),
  withUpstreamTimeout: async (p: Promise<any>) => p,
  detectMileageDiscrepancy: () => null, shopHistoryLabelFromProvider: () => "Shop history",
  trackViewedVin: async () => {}, computeIntervalProgress: () => ({}),
  hideInspectPlanItem: () => false, isComplimentaryItem: () => false,
  convertCachedPlanItemForSidePanel: (item: any) => item,
  backgroundPrefetchShopPlans: async () => {}, deleteReportApprovedItemsDoc: async () => {},
  buildReportUrl: (_vin: string, shop: number) => `https://fixture.test/report/${shop}`,
  getCachedPlan: async (_db: any, requestedVin: string, shop: number) => {
    historyReads++;
    assert.equal(shop, 33); assert.equal(requestedVin, vin);
    return { mileage: 50000, plan: { currentMiles: 50000, buckets: {
      overdue: [{ name: "Owner shop history recommendation" }], dueSoon: [], upcoming: [],
    } } };
  },
};
vm.createContext(sandbox);
vm.runInContext(ts.transpileModule(source.slice(source.indexOf("async function _GET("), source.indexOf("// Task #510: per-shop error-rate")), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText, sandbox);
function setup(extra: any[] = [], provider = "autoflow", legacy = false, shop = 33) {
  historyReads = 0;
  fake = makeFakeDb({ shops: [owner, ...extra], vehicles: [{ shopId: 33, vin, year: 2003, make: "Honda", model: "Accord" }] });
  auth = { authorized: true, user: { shopId: 33, shopIds: [33, 44] },
    principal: { isLegacy: legacy, shopId: shop, provider } };
}
const request = (id = "743", provider = "autoflow") => ({
  nextUrl: new URL(`https://fixture.test/api/extension/plan?provider=${provider}&shopId=${id}&vin=${vin}&roId=215617&odometer=50000`),
});
async function main() {
  for (const legacy of [false, true]) {
    for (const id of ["743", "744", "fixture", "fixture.autotext.me"]) {
      setup([], "autoflow", legacy);
      const response = await sandbox._GET(request(id));
      assert.equal(response.status, 200);
      assert.equal(response.body.vehicle.vin, vin);
      assert.equal(response.body.overdue[0].name, "Owner shop history recommendation");
      assert.equal(response.body.mileage, 50000);
      assert.equal(historyReads, 1);
      assert.ok(fake.ops.every(op => ["find", "findOne"].includes(op.op)), "no alias learning or provider-RO writes");
    }
    for (const [extra, id, status] of [
      [[], "9999", 404],
      [[{ shopId: 9999, tekmetric: { shopId: 9999 } }], "9999", 404],
      [[{ shopId: 99, autoflow: { shopNumbers: ["743"] } }], "743", 409],
      [[{ shopId: 99, autoflowDomain: "fixture" }], "fixture", 409],
      [[{ shopId: 99, autoflow: { shopId: "743" } }], "743", 403],
    ] as const) {
      setup([...extra], "autoflow", legacy);
      const response = await sandbox._GET(request(id));
      assert.equal(response.status, status);
      assert.equal(response.body.code, "SHOP_CONTEXT_UNAVAILABLE");
      assert.match(response.body.error, /Vehicle history has not been checked/);
      assert.doesNotMatch(response.body.error, /Tekmetric|99|fixture/);
      assert.equal(historyReads, 0);
      assert.ok(fake.ops.every(op => ["find", "findOne"].includes(op.op)));
    }
  }
  for (const provider of ["tekmetric", "shopmonkey", "protractor"]) {
    setup([{ shopId: 33, tekmetric: { shopId: 743 }, shopmonkey: { locationId: "743" } }], provider);
    const response = await sandbox._GET(request());
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "SESSION_CONTEXT_MISMATCH");
    assert.equal(fake.ops.length, 0, "foreign principal rejected before any namespace lookup");
    assert.equal(historyReads, 0);
  }
  setup([], "autoflow", false, 44);
  assert.equal((await sandbox._GET(request())).body.code, "SESSION_CONTEXT_MISMATCH");
  assert.equal(historyReads, 0);
  setup([{ shopId: 33, tekmetric: { shopId: 743 } }]);
  // The canonical AutoFlow owner still wins over unrelated provider identifiers.
  assert.equal((await sandbox._GET(request())).status, 200);
  setup();
  fake = makeFakeDb({ shops: [{ ...owner, tekmetric: { shopId: 743 } }],
    vehicles: [{ shopId: 33, vin, year: 2003, make: "Honda", model: "Accord" }] });
  assert.equal((await sandbox._GET(request())).status, 200);
  assert.ok(fake.ops.every(op => ["find", "findOne"].includes(op.op)),
    "dual-integration AutoFlow request never mirrors the AutoFlow odometer onto a Tekmetric RO");
  setup();
  auth.user.extensionPrincipal = auth.principal;
  delete auth.principal;
  assert.equal((await sandbox._GET(request())).status, 200, "embedded principal remains supported");
  auth.user.extensionPrincipal.provider = "tekmetric";
  assert.equal((await sandbox._GET(request())).body.code, "SESSION_CONTEXT_MISMATCH");
  setup();
  failLookup = true;
  assert.equal((await sandbox._GET(request())).status, 500);
  assert.equal(historyReads, 0);
  failLookup = false;
  await backgroundChecks();
  console.log("AutoFlow VHI context: route, read-only mapping, scope and worker recovery PASS");
}

async function backgroundChecks() {
  const worker = fs.readFileSync("mos-tools-extension/background.js", "utf8");
  let fetches = 0;
  const context = { provider: "autoflow", shopId: "743", roId: "215617", _tabId: 7 };
  const bg: any = {
    URL, console, _stateReady: Promise.resolve(), mosApiToken: "fixture-explicit",
    mosAuthSource: "explicit", currentSmsContext: context,
    ensureBootstrapBoundToActiveTab: async () => true,
    stickerLocationRequest: async () => { throw new Error("AutoFlow must not use Tekmetric/Shopmonkey switching"); },
    _doMosFetch: async (endpoint: string, options: any, token: string) => {
      fetches++;
      assert.equal(token, "fixture-explicit");
      assert.equal(new URL(endpoint, "https://fixture.test").searchParams.get("provider"), "autoflow");
      assert.equal(options.context, context);
      return { status: 403, ok: false, json: async () => ({
        code: "SESSION_CONTEXT_MISMATCH", error: "Explicitly sign in from the intended provider page. Vehicle history has not been checked.",
      }) };
    },
    MOS_AUTH_RETRY_DELAYS_MS: [1, 1], reportTelemetry() {}, reportSlowCallIfNeeded() {},
    MosTelemetryCore: { buildThrownFetchFailure: () => ({ emit: false }) },
  };
  vm.createContext(bg);
  vm.runInContext(worker.slice(worker.indexOf("async function handleMosApiRequest("), worker.indexOf("// ------ TEKMETRIC API FUNCTIONS")), bg);
  await assert.rejects(bg.handleMosApiRequest("/api/extension/plan?provider=autoflow&shopId=743", { context }),
    (error: any) => error.serverCode === "SESSION_CONTEXT_MISMATCH" && /history has not been checked/.test(error.message));
  assert.equal(fetches, 1, "context errors never trigger silent login or retries");
  assert.equal(bg.mosApiToken, "fixture-explicit", "context errors do not log out the user automatically");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
