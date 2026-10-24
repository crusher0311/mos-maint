// Fully isolated route contracts; preload deny-network-egress.cjs when running.
import assert from "node:assert/strict";
import { resolveTekmetricMaintenanceColor } from "../lib/tekmetric-maintenance-color";

const Module = require("node:module");
const original = Module._load;
let session: any = { shopId: 1, role: "owner" };
const shops = new Map<number, any>([
  [1, { shopId: 1, preferences: {} }],
  [2, { shopId: 2, preferences: {} }],
]);
let writes = 0;
let workOrders: any[] = [];
let buckets: any = {};
let guardAllowed = true;
let requestedProvider = "tekmetric";
const db = { collection() { return {
  async findOne(q: any) { return shops.get(q.shopId); },
  async updateOne(q: any, op: any) {
    writes++;
    for (const [key, value] of Object.entries(op.$set || {})) {
      shops.get(q.shopId).preferences[key.replace("preferences.", "")] = value;
    }
  },
}; } };
Module._load = function(name: string, ...args: any[]) {
  if (name === "server-only") return {};
  if (name === "@/lib/auth") return { getSession: async () => session };
  if (name === "@/lib/mongo") return { getDb: async () => db };
  if (name === "@/lib/enterprise") return { getEnterpriseByShopId: async () => null };
  if (name === "@/lib/shop-distance-unit") return { isOverrideUnit: () => false };
  if (name === "@/lib/extension-route-wrapper") return { withExtensionErrorMarker: (fn: any) => fn };
  if (name === "@/lib/extension-route-guard") return { guardExtensionShopRequest: async (_req: any, opts: any) => {
    assert.deepEqual(opts.requiredFeatures, ["maintenance", "dvi_prefill"]);
    if (!guardAllowed) return { ok: false, response: new Response("denied", { status: 403 }) };
    requestedProvider = opts.provider;
    return { ok: true, mosShopId: session.shopId, shopDoc: shops.get(session.shopId), provider: opts.provider };
  } };
  if (name === "@/lib/vhi-rebuild") return { rebuildVhi: async (id: number) => {
    assert.equal(id, session.shopId);
    return { success: true, buckets, score: 42 };
  } };
  if (name === "@/lib/data/repositories/tekmetric-work-orders") return {
    listRecentTekmetricWorkOrdersForVehicle: async (id: number) => {
      assert.equal(id, session.shopId);
      assert.equal(requestedProvider, "tekmetric");
      return workOrders;
    },
  };
  return original.call(this, name, ...args);
};
const prefs = require("../app/api/settings/preferences/route");
const analysis = require("../app/api/extension/prefill-dvi/route");
Module._load = original;
const req = (body: any) => new Request("http://fixture.invalid", { method: "POST", body: JSON.stringify(body) });
const put = (body: any) => prefs.PUT(req(body));
const getColor = async () => (await (await prefs.GET()).json()).tekmetricMaintenanceColor;
const analyze = async (provider = "tekmetric") => analysis.POST(req({
  vin: "1HGBH41JXMN109186", smsShopId: session.shopId, provider, mileage: 80000,
  inspectionTasks: [{ id: 10, name: "Engine Oil" }],
}));
const suggestion = async (provider = "tekmetric") => (await (await analyze(provider)).json());

async function main() {
  for (const invalid of [undefined, null, "", "YELLOW", "green", 2, {}, false]) {
    assert.equal(resolveTekmetricMaintenanceColor(invalid), "red");
    shops.get(1).preferences.tekmetricMaintenanceColor = invalid;
    assert.equal(await getColor(), "red");
    buckets = { overdue: [{ serviceKey: "oil", dueAtMiles: 70000 }] };
    assert.equal((await suggestion()).updates[0].rating.code, "RQRSATTN");
  }
  for (const invalid of [null, "", "YELLOW", "green", 2, {}, false]) {
    const before = writes;
    assert.equal((await put({ tekmetricMaintenanceColor: invalid })).status, 400);
    assert.equal(writes, before);
  }
  assert.equal((await put({ tekmetricMaintenanceColor: "yellow", shopId: 2 })).status, 200);
  assert.equal(await getColor(), "yellow");
  for (const role of ["viewer", "read_only", "readonly", "technician", "user", undefined]) {
    session = { shopId: 1, role };
    assert.equal((await (await prefs.GET()).json()).canManageTekmetricMaintenanceColor, false);
    for (const color of ["yellow", "red"]) {
      const before = writes;
      assert.equal((await put({ tekmetricMaintenanceColor: color, role: "owner" })).status, 403);
      assert.equal(writes, before);
    }
    assert.equal(await getColor(), "yellow");
    assert.equal((await put({ showRecalls: true })).status, 200, "existing unrelated permissions unchanged");
  }
  for (const role of ["owner", "admin", "manager"]) {
    session = { shopId: 1, role };
    assert.equal((await (await prefs.GET()).json()).canManageTekmetricMaintenanceColor, true);
    assert.equal((await put({ tekmetricMaintenanceColor: "red" })).status, 200);
    assert.equal(await getColor(), "red");
    assert.equal((await put({ tekmetricMaintenanceColor: "yellow" })).status, 200);
    assert.equal(await getColor(), "yellow");
  }
  await put({ showRecalls: false });
  assert.equal(await getColor(), "yellow");
  session = { shopId: 2, role: "owner" };
  assert.equal(await getColor(), "red");
  assert.equal((await suggestion()).updates[0].rating.code, "RQRSATTN");
  session = { shopId: 1, role: "owner" };
  let result = await suggestion();
  assert.equal(result.updates[0].rating.code, "MAYRQRATTN");
  assert.equal(result.updates[0].status, "overdue");
  assert.match(result.updates[0].finding, /OVERDUE/);
  assert.doesNotMatch(result.updates[0].finding, /immediate|urgent|defect/i);
  assert.equal(result.summary.overdue, 1);
  assert.equal(result.summary.red, 0);
  assert.equal(result.summary.yellow, 1);
  assert.equal(result.score, 42);
  for (const provider of ["autoflow", "shopware", "protractor", "shopmonkey"]) {
    assert.equal((await suggestion(provider)).updates[0].rating.code, "RQRSATTN");
  }
  for (const color of ["red", "yellow"]) {
    await put({ tekmetricMaintenanceColor: color });
    assert.equal(await getColor(), color);
    for (const [pastCode, expected] of [["RQRSATTN", "RQRSATTN"], ["MAYRQRATTN", "MAYRQRATTN"]]) {
      workOrders = [{ completedDate: "2025-06-01", inspections: [{
        inspectionTasks: [{ tasks: [{ name: "Engine Oil", inspectionRating: { code: pastCode }, finding: "Observed condition" }] }],
      }] }];
      result = await suggestion();
      assert.equal(result.updates[0].rating.code, expected);
      assert.equal(result.updates[0].basis, "inspection_history");
      buckets.overdue[0].last = { miles: 79900 };
      result = await suggestion();
      assert.equal(result.updates[0].rating.code, "CHCKD");
      assert.equal(result.updates[0].basis, "recently_performed");
      delete buckets.overdue[0].last;
    }
    workOrders = [];
    buckets = { dueSoon: [{ serviceKey: "oil", dueAtMiles: 80500 }] };
    assert.equal((await suggestion()).updates[0].rating.code, "MAYRQRATTN");
    buckets = { overdue: [{ serviceKey: "oil", dueAtMiles: 70000 }] };
    assert.equal((await suggestion()).updates[0].rating.code, color === "yellow" ? "MAYRQRATTN" : "RQRSATTN");
  }
  guardAllowed = false;
  assert.equal((await analyze()).status, 403);
  session = null;
  assert.equal((await prefs.GET()).status, 401);
  assert.equal((await put({ tekmetricMaintenanceColor: "yellow" })).status, 401);
  console.log("PASS maintenance color: validation, defaults, persistence, isolation, precedence, providers and gates");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
