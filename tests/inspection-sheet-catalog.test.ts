import test, {before, after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {isolatedStaffDatabase} from "./helpers/staff-inspection-fixture";
import {MongoSheetCatalog} from "../lib/data/repositories/inspection-sheet-catalog";
import {readCatalog, updateCatalog, type CatalogAccess} from "../lib/auto-dvi/staff/sheet-catalog";
import {STAFF_SHEET_TEMPLATES, initialInspection, applyStaffCommand, blankFinding} from "../lib/auto-dvi/staff/model";
import {selectableSheets} from "../lib/auto-dvi/staff/configuration";

let isolated: Awaited<ReturnType<typeof isolatedStaffDatabase>>;
before(async () => {isolated = await isolatedStaffDatabase(27834);});
after(async () => {await isolated.close();});
async function fixture() {
  const db = isolated.client.db(`catalog_${randomUUID().replaceAll("-", "")}`);
  let authority: CatalogAccess = {key: "shop:66", shopId: 66, actor: "manager", scope: "shop", scopeLabel: "Test shop", canManage: true};
  const store = new MongoSheetCatalog(async () => db);
  return {db, store, deps: {store, access: async () => ({...authority})},
    setAccess: (value: Partial<CatalogAccess>) => {authority = {...authority, ...value};}};
}
const sheet = (id = "basic") => ({...structuredClone(STAFF_SHEET_TEMPLATES[0]), id, version: 0});
const save = (s = sheet(), revision = 0, makeDefault = false) => ({
  requestId: randomUUID(), revision, command: {type: "save", sheet: s, makeDefault},
});

test("creates a catalog with real BSON readback and leaves admissions disabled", async () => {
  const f = await fixture();
  const response = await updateCatalog(save(), f.deps);
  assert.equal(response.revision, 1);
  assert.equal(response.defaultSheet, "basic@1");
  assert.equal(response.inspectionEnabled, false);
  assert.deepEqual((await readCatalog(f.deps)).sheets, response.sheets);
  const config = await f.store.read("shop:66");
  assert.deepEqual(config!.enabledShopIds, []);
  assert.equal(config!.pilot, undefined);
});
test("edits allocate immutable versions and do not change existing inspection evidence", async () => {
  const f = await fixture();
  const first = await updateCatalog(save(), f.deps);
  const inspection = initialInspection(first.sheets[0]);
  const before = structuredClone(inspection);
  const edited = {...first.sheets[0], name: "Updated basic", items: first.sheets[0].items.slice(0, 2)};
  const response = await updateCatalog(save(edited, 1), f.deps);
  assert.equal(response.sheets.length, 2);
  assert.equal(response.defaultSheet, "basic@2");
  assert.deepEqual(inspection, before);
  assert.deepEqual(response.sheets[0], first.sheets[0]);
  assert.deepEqual(selectableSheets((await f.store.read("shop:66"))!).map(s => s.version), [2]);
});
test("duplicate templates, default selection, archive/restore retain historic definitions", async () => {
  const f = await fixture();
  await updateCatalog(save(), f.deps);
  await updateCatalog(save(sheet("tires"), 1), f.deps);
  await assert.rejects(updateCatalog({requestId: randomUUID(), revision: 2,
    command: {type: "archive", sheetId: "basic", archived: true}}, f.deps), /different default/);
  await updateCatalog({requestId: randomUUID(), revision: 2, command: {type: "default", sheet: "tires@1"}}, f.deps);
  const archived = await updateCatalog({requestId: randomUUID(), revision: 3,
    command: {type: "archive", sheetId: "basic", archived: true}}, f.deps);
  assert.equal(archived.sheets.length, 2);
  assert.deepEqual(selectableSheets((await f.store.read("shop:66"))!).map(s => s.id), ["tires"]);
  await updateCatalog({requestId: randomUUID(), revision: 4, command: {type: "archive", sheetId: "basic", archived: false}}, f.deps);
  assert.equal(selectableSheets((await f.store.read("shop:66"))!).length, 2);
});
test("lost response exact retry creates only one version; changed-key reuse and stale revisions fail", async () => {
  const f = await fixture(), request = save();
  await updateCatalog(request, f.deps);
  assert.equal((await updateCatalog(request, f.deps)).sheets.length, 1);
  await assert.rejects(updateCatalog({...request, command: {...request.command, makeDefault: true}}, f.deps), /another sheet change/);
  await assert.rejects(updateCatalog(save(sheet("other")), f.deps), /changed/);
  assert.equal((await readCatalog(f.deps)).revision, 1);
});
test("simultaneous managers cannot overwrite one another", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([updateCatalog(save(), f.deps), updateCatalog(save(sheet("other")), f.deps)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await readCatalog(f.deps)).sheets.length, 1);
});
test("client scope/gates are rejected and read-only staff cannot mutate", async () => {
  const f = await fixture();
  await assert.rejects(updateCatalog({...save(), shopId: 1}, f.deps));
  await assert.rejects(updateCatalog({...save(), enabledShopIds: [66]}, f.deps));
  f.setAccess({canManage: false});
  assert.equal((await readCatalog(f.deps)).canManage, false);
  await assert.rejects(updateCatalog(save(), f.deps), /authorized managers/);
  assert.equal(await f.store.read("shop:66"), null);
});
test("revoked authority or changed enterprise scope stops the save", async () => {
  const f = await fixture();
  let calls = 0;
  const deps = {...f.deps, access: async () => {
    if (++calls > 1) f.setAccess({key: "enterprise:other", scope: "enterprise"});
    return f.deps.access();
  }};
  await assert.rejects(updateCatalog(save(), deps), /access changed/);
  assert.equal(await f.store.read("shop:66"), null);
});
test("catalog writes preserve rollout, individual restrictions and concurrent unrelated changes", async () => {
  const f = await fixture();
  await updateCatalog(save(), f.deps);
  await f.db.collection("workflow_staff_inspection_config").updateOne({_id: "shop:66" as any},
    {$set: {enabledShopIds: [66], individual: {restricted: {edit: "deny"}}}});
  const before = (await f.store.read("shop:66"))!;
  await updateCatalog(save(sheet("second"), 1), f.deps);
  const config = (await f.store.read("shop:66"))!;
  assert.deepEqual(config.enabledShopIds, [66]);
  assert.deepEqual(config.individual, before.individual);
  assert.equal(await f.store.cas("shop:66", before, {...before, defaultSheet: "basic@1"}), false);
});
test("rejects incompatible reused measurement identities and invalid choice fields", async () => {
  const f = await fixture();
  await updateCatalog(save(), f.deps);
  const incompatible = sheet("other");
  incompatible.items[0].fields.find(field => field.type === "number")!.type = "text";
  await assert.rejects(updateCatalog(save(incompatible, 1), f.deps), /new procedure identity/);
  const bad = sheet("other");
  const choice = bad.items[0].fields.find(field => field.type === "select")!;
  choice.options = [];
  await assert.rejects(updateCatalog(save(bad, 1), f.deps), /Choice fields/);
  assert.equal((await readCatalog(f.deps)).revision, 1);
});

test("matching items reuse findings within this visit without changing other visits", () => {
  const basic = {...sheet(), version: 1, items: [sheet().items[0]]};
  const detailed = {...basic, id: "detailed", name: "Detailed", items: [{...basic.items[0], id: "matching-tire"}]};
  const untouched = initialInspection(basic);
  let inspection = initialInspection(basic);
  inspection = applyStaffCommand(inspection, {type: "save", sheet: "basic@1", item: basic.items[0].id,
    finding: {...blankFinding(), rating: "green", notes: "Measured now", values: {unit: "32nds", inner: 7}}},
    [basic, detailed], "tech", "2026-10-20T10:00:00Z", false);
  inspection = applyStaffCommand(inspection, {type: "select", sheet: "detailed@1", keepActive: true},
    [basic, detailed], "tech", "2026-10-20T10:01:00Z", false);
  assert.equal(inspection.sheets[1].results["matching-tire"].values.inner, 7);
  inspection = applyStaffCommand(inspection, {type: "save", sheet: "detailed@1", item: "matching-tire",
    finding: {...blankFinding(), rating: "yellow", notes: "Remeasured now", values: {unit: "32nds", inner: 5}}},
    [basic, detailed], "tech", "2026-10-20T10:02:00Z", false);
  assert.equal(inspection.sheets[0].results[basic.items[0].id].values.inner, 5);
  assert.deepEqual(untouched.sheets[0].results, {});
});
