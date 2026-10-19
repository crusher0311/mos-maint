import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
const loader = Module as unknown as {_load: (id: string, ...args: any[]) => any}, original = loader._load;
let cookie: string | undefined = "dashboard-session", status = "active", reads = 0;
let session = {email: "staff@example.invalid", token: "dashboard-session", shopId: 1, role: "technician"};
loader._load = function(id, ...args) {
  if (id === "next/headers") return {cookies: async () => ({get: () => cookie ? {value: cookie} : undefined})};
  if (id === "@/lib/auth") return {getSession: async () => session};
  if (id === "@/lib/data/repositories/users") return {listUsers: async () => [{email: session.email, shopId: 1, role: "technician", status}]};
  if (id === "@/lib/enterprise") return {getEnterpriseByShopId: async () => null};
  if (id === "@/lib/featureResolver") return {getFeatureEntitlements: async () => ({isFeatureEnabled: () => true})};
  if (id === "@/lib/data/repositories/workflow-inspections") return {readStaffConfiguration: async () => null, StaffMediaStorage: class {}};
  if (id === "@/lib/auto-dvi/staff/runtime") {
    const {staffAccess} = require("../lib/auto-dvi/staff/access");
    return {staffDependencies: {access: staffAccess, board: {read: async () => {reads++; return {visits: [{id: "visit-one", closed: false}], revision: 0};}},
      repository: {read: async () => null}}};
  }
  return original.call(this, id, ...args);
};
const route = require("../app/api/shop-dispatch/inspection/route");
const media = require("../app/api/shop-dispatch/inspection/media/route");
loader._load = original;
function request(path: string, body?: unknown) {
  const url = `https://staff.invalid/api/shop-dispatch/inspection${path}`;
  return Object.assign(new Request(url, body ? {method: "POST", headers: {origin: "https://staff.invalid", host: "staff.invalid",
    "content-type": "application/json"}, body: JSON.stringify(body)} : {}), {nextUrl: new URL(url)});
}
test("staff endpoints reject revoked inactive membership and extension-only sessions before evidence reads", async () => {
  assert.equal((await route.GET(request("?visitId=visit-one"))).status, 200);
  reads = 0; status = "inactive";
  assert.equal((await route.GET(request("?visitId=visit-one"))).status, 403);
  assert.equal((await media.GET(request("/media?visitId=visit-one&sheet=test&item=test&mediaId=000000000000000000000001"))).status, 403);
  assert.equal((await route.POST(request("", {visitId: "visit-one", requestId: "11111111-1111-4111-8111-111111111111",
    revision: 0, command: {type: "initialize", boardRevision: 0}}))).status, 403);
  assert.equal(reads, 0);
  status = "active"; cookie = undefined; session = {...session, token: "exts_verified"};
  assert.equal((await route.GET(request("?visitId=visit-one"))).status, 401);
  assert.equal((await media.GET(request("/media?visitId=visit-one"))).status, 401);
  cookie = "exts_verified";
  assert.equal((await route.GET(request("?visitId=visit-one"))).status, 401);
  assert.equal(reads, 0);
});
