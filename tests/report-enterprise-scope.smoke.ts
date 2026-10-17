import assert from "node:assert/strict";
import { reportingScopeDependencies as deps, resolveReportingScope } from "../lib/reporting-scope";
async function main() {
  const shops: any[] = [1,2,3,99].map(shopId => ({ shopId, enterpriseId: shopId === 99 ? "other" : "jwt" }));
  deps.getEnterpriseById = async id => ({ _id: id, shopIds: String(id) === "jwt" ? [1,2,3] : [99] }) as any;
  deps.findShopByShopId = async id => shops.find(s => s.shopId === id);
  deps.listShopsByShopIds = async ids => shops.filter(s => ids.includes(s.shopId));
  deps.listAllShops = async () => shops;
  deps.listReportingUserShopAssignments = async () => [{ shopIds: [1,3,99] }];
  const session: any = { email: "fixture@example.test", shopId: 1, role: "owner", enterpriseId: "stale" };
  assert.deepEqual((await resolveReportingScope(session, { kind: "enterprise", enterpriseId: "jwt" })).shopIds, [1,3]);
  await assert.rejects(resolveReportingScope(session, { kind: "enterprise", enterpriseId: "other" }), /outside/);
  await assert.rejects(resolveReportingScope(session, { kind: "platform" }), /platform admin/);
  assert.deepEqual((await resolveReportingScope({ ...session, isPlatformAdmin: true }, { kind: "enterprise", enterpriseId: "jwt" })).shopIds, [1,2,3]);
  assert.deepEqual((await resolveReportingScope({ ...session, isPlatformAdmin: true }, { kind: "platform" })).shopIds, [1,2,3,99]);
  console.log("Enterprise intersection, stale session and explicit platform scope: PASS");
}
main().catch(error => { console.error(error); process.exitCode=1; });
