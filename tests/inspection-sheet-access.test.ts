import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import {randomUUID} from "node:crypto";
const loader = Module as any, original = loader._load;
let token: string | undefined = "dashboard-session", role = "manager", feature = true, active = true;
let enterprise: any = null, config: any = null, writes = 0;
const session: any = {email: "manager@example.invalid", shopId: 66, token: "dashboard-session"};
loader._load = function(id: string, ...args: any[]) {
  if (id === "next/headers") return {cookies: async () => ({get: () => token ? {value: token} : undefined})};
  if (id === "@/lib/auth") return {getSession: async () => session};
  if (id === "@/lib/data/repositories/users") return {listUsers: async () => [{shopId: 66, role, active}]};
  if (id === "@/lib/featureResolver") return {getFeatureEntitlements: async () => ({isFeatureEnabled: (key: string) => feature && key === "auto_dvi"})};
  if (id === "@/lib/enterprise") return {getEnterpriseByShopId: async () => enterprise};
  if (id === "@/lib/data/repositories/inspection-sheet-catalog") return {MongoSheetCatalog: class {
    async read() {return config;}
    async cas(_key: string, _before: unknown, after: unknown) {writes++; config = after; return true;}
  }};
  return original.call(this, id, ...args);
};
const route = require("../app/api/shop-dispatch/inspection/sheets/route");
const {STAFF_SHEET_TEMPLATES} = require("../lib/auto-dvi/staff/model");
loader._load = original;
function request() {
  const url = "https://catalog.invalid/api/shop-dispatch/inspection/sheets";
  return new Request(url, {method: "POST", headers: {"content-type": "application/json", origin: "https://catalog.invalid", host: "catalog.invalid"},
    body: JSON.stringify({requestId: randomUUID(), revision: 0,
      command: {type: "save", sheet: {...STAFF_SHEET_TEMPLATES[0], version: 0}, makeDefault: true}})});
}
test("catalog requires DVI, fresh membership and a dashboard session, independently of workflow entitlement", async () => {
  feature = false;
  assert.equal((await route.GET()).status, 403);
  assert.equal((await route.POST(request())).status, 403);
  feature = true; active = false;
  assert.equal((await route.GET()).status, 403);
  active = true; token = "exts_extension"; session.token = token;
  assert.equal((await route.GET()).status, 401);
  token = "dashboard-session"; session.token = token;
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).canManage, true);
  assert.equal(writes, 0);
});
test("technicians and advisors cannot edit; enterprise catalog uses fresh owner/admin authority", async () => {
  for (role of ["technician", "advisor"]) {
    assert.equal((await (await route.GET()).json()).canManage, false);
    assert.equal((await route.POST(request())).status, 403);
  }
  role = "manager"; enterprise = {_id: "enterprise-test", name: "Test Enterprise", shopIds: [66, 67]};
  let result = await (await route.GET()).json();
  assert.equal(result.scope, "enterprise");
  assert.equal(result.canManage, false);
  assert.equal((await route.POST(request())).status, 403);
  role = "owner";
  result = await (await route.GET()).json();
  assert.equal(result.canManage, true);
  assert.equal((await route.POST(request())).status, 200);
  assert.equal(writes, 1);
  assert.deepEqual(config.enabledShopIds, [], "Building shared sheets never activates other locations");
});
test("explicit enterprise edit restrictions and cross-origin writes remain denied", async () => {
  config.rules = {edit: "deny"};
  assert.equal((await (await route.GET()).json()).canManage, false);
  assert.equal((await route.POST(request())).status, 403);
  const req = request();
  req.headers.set("origin", "https://foreign.invalid");
  assert.equal((await route.POST(req)).status, 403);
  assert.equal(writes, 1);
});
