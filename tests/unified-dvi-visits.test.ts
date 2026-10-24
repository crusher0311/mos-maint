import test, {before, after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {isolatedStaffDatabase, staffFixture} from "./helpers/staff-inspection-fixture";
import {listInspectionVisits} from "../lib/auto-dvi/staff/visit-selection";
import {prepareVisitAssistance} from "../lib/auto-dvi/staff/assistance";
import {mutateStaff, snapshot} from "../lib/auto-dvi/staff/service";
import {TIRE_BATTERY_SHEET} from "../lib/auto-dvi/staff/tire-battery-sheet";
import {blankFinding} from "../lib/auto-dvi/staff/model";
let isolated: Awaited<ReturnType<typeof isolatedStaffDatabase>>;
before(async () => {isolated = await isolatedStaffDatabase(27836);});
after(async () => {await isolated?.close();});
const vin = "1HGCM82633A004352";
test("dashboard VIN lists canonical repeat visits but never selects, creates or infers displayed RO ownership", async () => {
  const f = await staffFixture(isolated.client), board = await f.deps.board.read(1);
  const sourceId = randomUUID();
  board.visits[0].provider = "protractor"; board.visits[0].sourceId = sourceId;
  board.visits[1].provider = "protractor"; board.visits[1].sourceId = randomUUID();
  await f.deps.board.save(1, board.revision, board);
  let calls = 0;
  const deps = {access: f.deps.access, read: f.deps.board.read, references: async (shop: number, ids: string[]) => {
    calls++; assert.equal(shop, 1); assert.deepEqual(ids, board.visits.map(v => v.sourceId));
    return ids.map(sourceId => ({sourceId, vin}));
  }};
  const listed = await listInspectionVisits(vin, deps);
  assert.equal(listed.visits.length, 2);
  assert.equal((listed as any).selected, undefined);
  assert.equal((await snapshot("visit-one", f.deps)).record, null);
  assert.equal(calls, 1);
  assert.equal((await listInspectionVisits(vin, {...deps, references: async () => []})).visits.length, 0);
  assert.equal((await listInspectionVisits(vin, {...deps, references: async () => [{sourceId, vin}, {sourceId, vin: "NOT-A-VIN"}]})).visits.length, 0);
  f.setAccess({authority: {...f.access.authority, member: false}});
  await assert.rejects(listInspectionVisits(vin, deps), /revoked/);
});
test("assistance uses selected visit and original revision; identity and entitlement changes invalidate delayed results", async () => {
  const f = await staffFixture(isolated.client);
  const board = await f.deps.board.read(1), sourceId = randomUUID();
  Object.assign(board.visits[0], {provider: "protractor", sourceId, sourceStatus: "WorkOrder"});
  await f.deps.board.save(1, board.revision, board);
  const initial = await f.initialize();
  const reader = async (shop: number, id: string) => {assert.equal(shop, 1); assert.equal(id, sourceId); return {sourceId, vin};};
  const context = await prepareVisitAssistance("visit-one", initial.inspection!.revision, f.deps, reader);
  assert.equal((await context.vehicle()).vin, vin);
  await assert.rejects(prepareVisitAssistance("visit-one", undefined, f.deps, reader), /revision/);
  await assert.rejects(prepareVisitAssistance("visit-two", initial.inspection!.revision, f.deps, reader), /binding/);
  const wrong = await prepareVisitAssistance("visit-one", initial.inspection!.revision, f.deps, async () => ({sourceId: randomUUID(), vin}));
  await assert.rejects(wrong.vehicle(), /Canonical/);
  const req = {visitId: "visit-one", requestId: randomUUID(), revision: initial.inspection!.revision,
    command: {type: "add-checks", items: [{id: "generated-check", name: "Oil condition", source: "vhi", reference: "vhi:oil"}]}};
  const result = await mutateStaff(req, f.deps);
  assert.equal(result.inspection!.sheets.at(-1)!.results["generated-check"], undefined);
  await assert.rejects(context.revalidate(), /changed/);
  const fresh = await prepareVisitAssistance("visit-one", result.inspection!.revision, f.deps, reader);
  f.setAccess({canEdit: false});
  await assert.rejects(fresh.revalidate(), /disabled|permitted/);
});
test("Tire & Battery persistence, exact retry, same-visit reuse and separate repeat visits", async () => {
  const f = await staffFixture(isolated.client);
  f.setAccess({canReview: true, config: {...f.access.config!, sheets: [TIRE_BATTERY_SHEET], defaultSheet: "tire-battery@1"}});
  let s = await f.initialize();
  for (const item of TIRE_BATTERY_SHEET.items) {
    const req = {visitId: "visit-one", requestId: randomUUID(), revision: s.inspection!.revision, command: {
      type: "save", sheet: "tire-battery@1", item: item.id, finding: {...blankFinding(), rating: "green",
        notes: "Measured and manually documented", values: item.capture === "tire-v1"
          ? {actualSize: item.position?.endsWith("r") ? "255/40R18" : "225/45R18", availability: "measured", unit: "mm", inner: 7, center: 8, outer: 7, beforePsi: 34}
          : {rated: 760, measured: 724, ratedStandard: "CCA", measuredStandard: "CCA", outcome: "pass"}}}};
    s = await mutateStaff(req, f.deps);
    assert.deepEqual((await mutateStaff(req, f.deps)).inspection, s.inspection);
  }
  s = await mutateStaff({visitId: "visit-one", requestId: randomUUID(), revision: s.inspection!.revision, command: {type: "review"}}, f.deps);
  const reload = await snapshot("visit-one", f.deps);
  assert.equal(reload.inspection!.reviewed?.revision, reload.inspection!.evidenceRevision);
  assert.deepEqual(reload.inspection, s.inspection);
  const next = await f.initialize("visit-two");
  assert.deepEqual(next.inspection!.sheets[0].results, {});
});
