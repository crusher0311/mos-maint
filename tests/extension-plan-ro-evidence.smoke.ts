// Network-denied route-level provider read and cache regressions.
import assert from "node:assert/strict";
import fs from "node:fs";

async function main() {
  const { __deps, fetchTekmetricRoCached, readNativeRoJobTitles, convertCachedPlanItemForSidePanel, canReadNativeTekmetricRo } =
    await import("../app/api/extension/plan/route-handler");
  const saved = { ...__deps };
  const title = "Lubricate door hinges";
  const calls: unknown[] = [];
  let names = [title];
  const guid = "11111111-2222-3333-4444-555555555555";
  try {
    __deps.isRoNegativelyCached = async () => false;
    __deps.recordRoNegativeCache = async () => {};
    __deps.clearRoNegativeCache = async () => {};
    __deps.tekmetricRequest = async (path, shop) => {
      calls.push([path, shop]);
      return { jobs: names.map(name => ({ name })), shopId: shop };
    };
    const first = await fetchTekmetricRoCached("collision", false, 41);
    names = [];
    assert.equal((await fetchTekmetricRoCached("collision", false, 41)), first, "normal read reuses cache");
    assert.deepEqual((await fetchTekmetricRoCached("collision", false, 42)).jobs, [], "another shop cannot reuse RO evidence");
    assert.deepEqual((await fetchTekmetricRoCached("collision", true, 41)).jobs, [], "forced RO refresh sees removal");
    names = [title];
    assert.equal((await fetchTekmetricRoCached("collision", true, 41)).jobs[0].name, title, "post-add refresh bypasses pre-add cache");
    assert.equal(calls.length, 4);
    __deps.resolveProtractorRo = async (shop, ro) => {
      assert.equal(shop, 41); assert.equal(ro, "123");
      return { ok: true, workOrderGuid: guid };
    };
    __deps.readProtractorRo = async (shop, id) => {
      assert.equal(shop, 41); assert.equal(id, guid);
      return { ok: true, workOrder: { ID: guid, WorkOrderNumber: 123,
        ServicePackages: names.map(Title => ({ Title, Description: "Not the title" })) } as any };
    };
    __deps.readShopwareRo = async (tenant, ro, shop) => {
      assert.deepEqual([tenant, ro, shop], [9, 123, 41]);
      return { id: 123, shop_id: 8, services: names.map(title => ({ title })) } as any;
    };
    for (const provider of ["shopware", "protractor"]) {
      for (const present of [true, false]) {
        names = present ? [title] : [];
        const titles = await readNativeRoJobTitles(provider, 41, "123", { shopware: { tenantId: 9, swShopId: 8 } });
        assert.deepEqual(titles, names, `${provider}: live detail reflects addition/removal`);
        for (const bucket of ["overdue", "dueSoon", "complimentary"] as const) {
          const item = convertCachedPlanItemForSidePanel({ title, onCurrentRO: !present }, bucket, {
            cachedCurrentMiles: 50000, currentRoAuthorizedJobs: [], currentRoAllJobs: titles!,
          });
          assert.equal(item.onCurrentRO, present, `${provider} ${bucket}: route conversion uses native detail evidence`);
        }
      }
    }
    assert.equal(await readNativeRoJobTitles("autoflow", 41, "123", {}), null, "never reinterpret AutoFlow IDs as linked-provider ROs");
    assert.equal(await readNativeRoJobTitles("shopware", 41, "123", { shopware: { tenantId: 9, swShopId: 999 } }), null, "sibling location rejected");
    __deps.readProtractorRo = async () => ({ ok: true, workOrder: { ID: guid, WorkOrderNumber: 124, ServicePackages: [] } as any });
    assert.equal(await readNativeRoJobTitles("protractor", 41, "123", {}), null, "resolved Protractor detail must match requested RO");
    __deps.readShopwareRo = async () => ({ id: 123, shop_id: 8 } as any);
    assert.equal(await readNativeRoJobTitles("shopware", 41, "123", { shopware: { tenantId: 9, swShopId: 8 } }), null, "missing association is unavailable, not verified empty");
    const route = fs.readFileSync("app/api/extension/plan/route-handler.ts", "utf8");
    assert.equal(canReadNativeTekmetricRo("tekmetric", true), false, "dual AutoFlow/Tekmetric cannot read a native RO by AutoFlow ID");
    assert.equal(canReadNativeTekmetricRo("tekmetric", false), true);
    assert.equal(canReadNativeTekmetricRo("protractor", false), false);
    assert.equal((route.match(/canReadNativeTekmetricRo\(provider, isAutoflowAnchored\)/g) || []).length, 3, "all native Tekmetric RO read branches enforce identity guard");
    assert.equal((route.match(/fetchTekmetricRoCached\(String\(roId\), refreshRo,/g) || []).length, 3);
    assert.equal((route.match(/currentRoJobTitles: currentRoEvidenceAvailable \? currentRoAllJobs : null/g) || []).length, 2, "cached and fresh responses expose identical verified evidence");
    const panel = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8");
    assert.match(panel, /recommendationAddEvidence\.has\(cacheKey\).*params\.set\('refreshRo', 'true'\)/);
    console.log("Extension plan native RO evidence and shop-scoped freshness: PASS");
  } finally { Object.assign(__deps, saved); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
