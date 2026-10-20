import test, {before, after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {isolatedStaffDatabase, staffFixture} from "./helpers/staff-inspection-fixture";
import {deriveIdempotentUpstreamId} from "../lib/idempotent-create-id";
import {mutateStaff, snapshot} from "../lib/auto-dvi/staff/service";
import {blankFinding} from "../lib/auto-dvi/staff/model";
import {StaffRepository} from "../lib/auto-dvi/staff/store";
import {MongoStaffPersistence} from "../lib/data/repositories/workflow-inspections";
import {executePilot, pilotStatus, type PilotDependencies} from "../lib/auto-dvi/pilot/service";
import {SYNTHETIC_CONTACT, SYNTHETIC_VEHICLE, SYNTHETIC_VIN, connectionHash, classifyPilot} from "../lib/auto-dvi/pilot/model";
import {tryDurablePush, DURABLE_DVI_ENROLLMENTS} from "../lib/auto-dvi/durable/runtime";

let isolated: Awaited<ReturnType<typeof isolatedStaffDatabase>>;
before(async () => {isolated = await isolatedStaffDatabase(27828);});
after(async () => {await isolated?.close();});
async function fixture() {
  const f = await staffFixture(isolated.client);
  const board = await f.deps.board.read(1);
  const payload = {customer: "Synthetic test", vehicle: "Synthetic vehicle", contactId: SYNTHETIC_CONTACT,
    vehicleId: SYNTHETIC_VEHICLE, newCustomer: null, newVehicle: null, identityConfirmed: true,
    concerns: ["Synthetic check-in"], mileage: 10000, customerPlan: "waiting" as const,
    neededBy: null, promiseAt: null, nextUpdateAt: null, commitmentsConfirmed: false};
  board.visits.forEach(v => {
    v.provider = "protractor";
    v.sourceId = deriveIdempotentUpstreamId("workOrder", 66, "workflow-intake", v.id);
  });
  board.ticketIntents = board.visits.map(v => ({id: randomUUID(), visitId: v.id, actor: "fixture",
    digest: "fixture", createdAt: new Date().toISOString(), status: "confirmed", message: "",
    payload, contactId: SYNTHETIC_CONTACT, vehicleId: SYNTHETIC_VEHICLE, workOrderId: v.sourceId!, attempted: ["workOrder"]}));
  await f.db.collection("fixture_boards").insertOne({_id: "shop:66", ...board} as any);
  f.setAccess({shopId: 66, actor: "advisor", canReview: true,
    authority: {...f.access.authority, currentShopId: 66, actorId: "advisor", roles: ["advisor"]},
    config: {...f.access.config!, enabledShopIds: [66], pilot: {admissions: true,
      connectionHash: connectionHash("synthetic-connection"), labels: {green: "Test OK", yellow: "Test Later", red: "Test Required"},
      labelEvidence: "synthetic_roundtrip_only"}}});
  const orders = new Map(board.visits.map(v => [v.sourceId!, {
    ID: v.sourceId, Type: "WorkOrder", Completed: false, Contact: {ID: SYNTHETIC_CONTACT},
    ServiceItem: {ID: SYNTHETIC_VEHICLE, VIN: SYNTHETIC_VIN},
    ServicePackages: {ItemCollection: [{ID: randomUUID(), Chapter: "Service",
      ServicePackageHeader: {Title: "Existing unrelated work"}, ServicePackageLines: {ItemCollection: [
        {ID: randomUUID(), Type: "Labor", Price: "99.00", Quantity: "1", Description: "Preserve me"},
      ]}}]},
  }]));
  let sends = 0, sendMode: "normal" | "lost" | "partial" | "absent" = "normal";
  const deps: PilotDependencies = {...f.deps, provider: {
    connection: async () => connectionHash("synthetic-connection"),
    read: async guid => structuredClone(orders.get(guid)!),
    send: async (guid, body) => {
      sends++;
      const pkg = structuredClone(body.ItemCollection[0]);
      assert.equal(pkg.Chapter, "Inspection");
      assert.equal(pkg.ServicePackageLines, undefined, "Never send labor or priced packages");
      if (sendMode === "partial") pkg.ServicePackageInspectionLines.ItemCollection = [];
      if (sendMode !== "absent") orders.get(guid)!.ServicePackages.ItemCollection.push(pkg);
      if (sendMode === "lost" || sendMode === "absent") throw Error("Lost provider response");
      return true;
    },
  }};
  async function ready(visitId = "visit-one") {
    let s = await mutateStaff({visitId, requestId: randomUUID(), revision: 0,
      command: {type: "initialize", boardRevision: (await deps.board.read(66)).revision}}, deps);
    s = await mutateStaff({visitId, requestId: randomUUID(), revision: s.inspection!.revision, command: {
      type: "save", sheet: "fixture@1", item: "tire.lf", finding: {...blankFinding(),
        rating: "green", notes: "Measured manually", values: {unit: "32nds", inner: 7, center: 8, outer: 7, beforePsi: 32}}}}, deps);
    return mutateStaff({visitId, requestId: randomUUID(), revision: s.inspection!.revision, command: {type: "review"}}, deps);
  }
  async function preview(visitId = "visit-one") {
    const state = await snapshot(visitId, deps);
    return executePilot({action: "preview", requestId: randomUUID(), visitId,
      evidenceRevision: state.inspection!.evidenceRevision, selected: [{sheet: "fixture@1", item: "tire.lf"}]}, deps);
  }
  return {...f, deps, orders, ready, preview, get sends() {return sends;}, setMode(mode: typeof sendMode) {sendMode = mode;}};
}
const send = (id: string, visitId = "visit-one") => ({action: "send", visitId, previewId: id, confirmed: true});

async function enableAllRecords(f: Awaited<ReturnType<typeof fixture>>, imported = true) {
  f.setAccess({config: {...f.access.config!, pilot: {...f.access.config!.pilot!, targetScope: "shop_test_instance"}}});
  if (imported) await f.db.collection("fixture_boards").updateOne({_id: "shop:66" as any}, {$set: {ticketIntents: []}});
  const guid = (await f.deps.board.read(66)).visits[0].sourceId!;
  const order = f.orders.get(guid)!;
  order.Contact.ID = randomUUID();
  order.ServiceItem.ID = randomUUID();
  order.ServiceItem.VIN = "TEST-INSTANCE-VEHICLE";
  return {guid, order};
}

test("all-records scope supports existing imported open tickets and arbitrary test customers", async () => {
  const f = await fixture();
  await enableAllRecords(f);
  await f.ready();
  const preview = await f.preview();
  const result = await executePilot(send(preview.operation!.id), f.deps);
  assert.equal(result.operation!.state, "confirmed");
  assert.equal(f.sends, 1);
  await executePilot(send(preview.operation!.id), f.deps);
  assert.equal(f.sends, 1);
  const operation = (await f.repository.persistence.read(66)).pilotOperations![0];
  assert.equal(operation.targetScope, "shop_test_instance");
});

test("new confirmed tickets can flow into inspection with non-fixture identities", async () => {
  const f = await fixture();
  await enableAllRecords(f, false);
  await f.ready();
  const preview = await f.preview();
  assert.equal((await executePilot(send(preview.operation!.id), f.deps)).operation!.state, "confirmed");
});

test("all-records opt-in still rejects closed native orders and identity changes before send", async () => {
  const f = await fixture();
  const {order} = await enableAllRecords(f);
  await f.ready();
  order.Completed = true;
  await assert.rejects(f.preview(), /Open work order/);
  order.Completed = false;
  const preview = await f.preview();
  order.Contact.ID = randomUUID();
  await assert.rejects(executePilot(send(preview.operation!.id), f.deps), /changed since preview/);
  assert.equal(f.sends, 0);
});

test("legacy scope does not silently permit existing customer tickets", async () => {
  const f = await fixture();
  await f.db.collection("fixture_boards").updateOne({_id: "shop:66" as any}, {$set: {ticketIntents: []}});
  await f.ready();
  await assert.rejects(f.preview(), /synthetic fixture/);
  assert.equal(f.sends, 0);
});

test("all-records permission stays in shop 66 and does not bypass uncertain ticket recovery", async () => {
  const f = await fixture();
  await enableAllRecords(f, false);
  await f.ready();
  await f.db.collection("fixture_boards").updateOne({_id: "shop:66" as any}, {$set: {"ticketIntents.0.status": "pending"}});
  await assert.rejects(f.preview(), /Recover the existing ticket/);
  assert.equal(f.sends, 0);
  f.setAccess({shopId: 1});
  await assert.rejects(executePilot({action: "preview", requestId: randomUUID(), visitId: "visit-one",
    evidenceRevision: 0, selected: [{sheet: "fixture@1", item: "tire.lf"}]}, f.deps), /CAR Experts test instance/);
  assert.equal(f.sends, 0);
});

test("all-records lost response stays one send and readback detects vehicle replacement", async () => {
  const f = await fixture();
  const {order} = await enableAllRecords(f);
  await f.ready();
  f.setMode("lost");
  const preview = await f.preview();
  await executePilot(send(preview.operation!.id), f.deps);
  await executePilot(send(preview.operation!.id), f.deps);
  assert.equal(f.sends, 1);
  const operation = (await f.repository.persistence.read(66)).pilotOperations![0];
  order.ServiceItem.ID = randomUUID();
  assert.equal(classifyPilot(operation, order), "conflict");
});

test("approved production sheet survives real Mongo serialization with omitted positions", async () => {
  const {STAFF_SHEET_TEMPLATES, sheetSchema} = await import("../lib/auto-dvi/staff/model");
  const f = await fixture();
  await f.db.collection("sheet_roundtrip").insertOne({sheets: STAFF_SHEET_TEMPLATES});
  const stored = await f.db.collection("sheet_roundtrip").findOne({});
  for (const sheet of stored!.sheets) assert.deepEqual(sheetSchema.parse(sheet), STAFF_SHEET_TEMPLATES[0]);
});

test("real workflow concern package shape survives preview through native readback", async () => {
  const {buildConcernServicePackages} = await import("../lib/integrations/protractor/client");
  const f = await fixture(); await f.ready();
  const guid = (await f.deps.board.read(66)).visits[0].sourceId!;
  const concerns = buildConcernServicePackages({workOrderId: guid, concerns: ["Synthetic check-in"]});
  (f.orders.get(guid)!.ServicePackages.ItemCollection as any[]).push(...concerns);
  const p = await f.preview();
  const result = await executePilot(send(p.operation!.id), f.deps);
  assert.equal(result.operation!.state, "confirmed");
  assert.deepEqual(f.orders.get(guid)!.ServicePackages.ItemCollection[1], concerns[0]);
  assert.equal(f.sends, 1);
  const op = (await f.repository.persistence.read(66)).pilotOperations![0];
  const malformed = structuredClone(f.orders.get(guid));
  delete (malformed!.ServicePackages.ItemCollection[1] as any).ServicePackageLines;
  assert.equal(classifyPilot(op, malformed), "conflict");
});

test("strict readback rejects priced additions, unknown fields and malformed nested collections", async () => {
  const f = await fixture(); await f.ready(); await f.preview();
  const op = (await f.repository.persistence.read(66)).pilotOperations![0];
  const expected = structuredClone(op.baseline);
  expected.ServicePackages.ItemCollection.push(structuredClone(op.payload.ItemCollection[0]));
  assert.equal(classifyPilot(op, expected), "confirmed");
  for (const edit of [
    (r: any) => {r.ServicePackages.ItemCollection.at(-1).ServicePackageLines = {ItemCollection: [{ID: randomUUID(), Price: "99"}]};},
    (r: any) => {r.ServicePackages.ItemCollection.at(-1).Price = 99;},
    (r: any) => {r.ServicePackages.unexpected = true;},
    (r: any) => {delete r.ServicePackages.ItemCollection.at(-1).ServicePackageInspectionLines;},
    (r: any) => {r.ServicePackages.ItemCollection.at(-1).ServicePackageInspectionLines = {ItemCollection: null};},
    (r: any) => {r.ServicePackages.ItemCollection.at(-1).ServicePackageInspectionLines.extra = true;},
  ]) {
    const observed = structuredClone(expected); edit(observed);
    assert.equal(classifyPilot(op, observed), "conflict");
  }
  const partial = structuredClone(expected);
  partial.ServicePackages.ItemCollection.at(-1).ServicePackageInspectionLines.ItemCollection = [];
  assert.equal(classifyPilot(op, partial), "partial");
  partial.ServicePackages.ItemCollection.at(-1).Total = 99;
  assert.equal(classifyPilot(op, partial), "conflict");
});

test("reviewed visit preview, exact native-only write, persisted readback and repeated clicks", async () => {
  const f = await fixture(); await f.ready();
  const preview = await f.preview();
  assert.equal(preview.operation!.state, "preview");
  assert.match(preview.operation!.lines[0].notes, /32nds/);
  assert.equal(preview.operation!.lines[0].result, "Test OK");
  const guid = preview.operation!.workOrderGuid;
  const unrelated = structuredClone(f.orders.get(guid)!.ServicePackages.ItemCollection[0]);
  await executePilot(send(preview.operation!.id), f.deps);
  assert.equal((await pilotStatus("visit-one", f.deps)).operation!.state, "confirmed");
  assert.deepEqual(f.orders.get(guid)!.ServicePackages.ItemCollection[0], unrelated);
  const reopened = {...f.deps, repository: new StaffRepository(new MongoStaffPersistence(async () => f.db))};
  await executePilot(send(preview.operation!.id), reopened);
  await executePilot({action: "reconcile", visitId: "visit-one"}, reopened);
  assert.equal(f.sends, 1);
  await assert.rejects(f.preview(), /already owns/);
});
test("same VIN new visit never supplies previous results or targets", async () => {
  const f = await fixture(); await f.ready();
  const first = await f.preview();
  await assert.rejects(executePilot(send(first.operation!.id, "visit-two"), f.deps), /Initialize and save/);
  await f.ready("visit-two");
  await assert.rejects(executePilot(send(first.operation!.id, "visit-two"), f.deps), /Saved preview/);
  const second = await f.preview("visit-two");
  assert.notEqual(first.operation!.workOrderGuid, second.operation!.workOrderGuid);
  await executePilot(send(second.operation!.id, "visit-two"), f.deps);
  assert.equal(f.orders.get(first.operation!.workOrderGuid)!.ServicePackages.ItemCollection.length, 1);
});
test("lost provider response and concurrent send cannot duplicate packages", async () => {
  const f = await fixture(); await f.ready(); f.setMode("lost");
  const p = await f.preview();
  await Promise.allSettled([executePilot(send(p.operation!.id), f.deps), executePilot(send(p.operation!.id), f.deps)]);
  assert.equal(f.sends, 1);
  assert.equal((await pilotStatus("visit-one", f.deps)).operation!.state, "confirmed");
  assert.equal((await pilotStatus("visit-one", f.deps)).operation!.acknowledged, false);
});
test("lost local admission acknowledgment never sends and never resumes", async () => {
  const f = await fixture(); await f.ready();
  const p = await f.preview(), original = f.persistence.cas.bind(f.persistence);
  let lose = true;
  f.persistence.cas = async (shop, revision, state) => {
    const result = await original(shop, revision, state);
    if (lose && state.pilotOperations?.some(o => o.state === "admitted")) {lose = false; throw Error("Lost commit response");}
    return result;
  };
  await assert.rejects(executePilot(send(p.operation!.id), f.deps), /Lost commit/);
  await executePilot(send(p.operation!.id), f.deps);
  await executePilot({action: "reconcile", visitId: "visit-one"}, f.deps);
  assert.equal(f.sends, 0);
  assert.equal((await pilotStatus("visit-one", f.deps)).operation!.state, "pending");
});
test("partial native outcome, provider edit, closed order, wrong shop, revoked permission", async () => {
  const f = await fixture(); await f.ready(); f.setMode("partial");
  const p = await f.preview();
  await executePilot(send(p.operation!.id), f.deps);
  assert.equal((await pilotStatus("visit-one", f.deps)).operation!.state, "partial");
  await executePilot(send(p.operation!.id), f.deps);
  assert.equal(f.sends, 1);
  const g = await fixture(); await g.ready(); const q = await g.preview();
  const order = g.orders.get(q.operation!.workOrderGuid)!;
  order.ServicePackages.ItemCollection[0].ServicePackageLines.ItemCollection[0].Price = "100.00";
  await assert.rejects(executePilot(send(q.operation!.id), g.deps), /Provider order changed/);
  order.Completed = true;
  await assert.rejects(g.preview(), /Open work order/);
  g.setAccess({shopId: 1});
  await assert.rejects(executePilot(send(q.operation!.id), g.deps), /CAR Experts/);
  g.setAccess({shopId: 66, canEdit: false});
  await assert.rejects(executePilot(send(q.operation!.id), g.deps), /access/);
  assert.equal(g.sends, 0);
});
test("concurrent evidence edit invalidates review and frozen preview", async () => {
  const f = await fixture(); await f.ready();
  const p = await f.preview(), s = await snapshot("visit-one", f.deps);
  await mutateStaff({visitId: "visit-one", requestId: randomUUID(), revision: s.inspection!.revision,
    command: {type: "save", sheet: "fixture@1", item: "tire.lf", finding: {...blankFinding(), rating: "red", notes: "New evidence",
      values: {unit: "32nds", inner: 2, center: 2, outer: 2, beforePsi: 32}}}}, f.deps);
  await assert.rejects(executePilot(send(p.operation!.id), f.deps), /Review/);
  assert.equal(f.sends, 0);
});
test("rollback preserves read/status/receipts and legacy dashboard/extension cannot write", async () => {
  const f = await fixture(); await f.ready(); f.setMode("absent");
  const p = await f.preview(); await executePilot(send(p.operation!.id), f.deps);
  f.setAccess({enabled: false, canEdit: false, config: {...f.access.config!, enabledShopIds: [],
    pilot: {...f.access.config!.pilot!, admissions: false}}});
  const status = await pilotStatus("visit-one", f.deps);
  assert.equal(status.operation!.state, "pending");
  await executePilot(send(p.operation!.id), f.deps);
  await executePilot({action: "reconcile", visitId: "visit-one"}, f.deps);
  assert.equal(f.sends, 1);
  for (const channel of ["dashboard", "extension"] as const) {
    const reply = await tryDurablePush({shopId: 66, actor: "fixture"}, {}, channel);
    assert.equal(reply?.body.error, "WORKFLOW_SYNTHETIC_PILOT_ONLY");
  }
  assert.deepEqual(DURABLE_DVI_ENROLLMENTS, {});
});
test("cannot claim a customer order by GUID or a browser-priced payload", async () => {
  const f = await fixture(); await f.ready(); const p = await f.preview();
  await assert.rejects(executePilot({...send(p.operation!.id), recommendedItems: [{name: "Price me"}]}, f.deps));
  const board = await f.deps.board.read(66);
  board.ticketIntents![0].contactId = randomUUID();
  await f.deps.board.save(66, board.revision, {...board, revision: board.revision + 1});
  await assert.rejects(executePilot(send(p.operation!.id), f.deps), /synthetic fixture/);
  assert.equal(f.sends, 0);
});
test("permission revoked during provider preflight stops admission", async () => {
  const f = await fixture(); await f.ready(); const p = await f.preview();
  const read = f.deps.provider.read;
  f.deps.provider.read = async (...args) => {
    const value = await read(...args);
    f.setAccess({canEdit: false});
    return value;
  };
  await assert.rejects(executePilot(send(p.operation!.id), f.deps), /access/);
  assert.equal(f.sends, 0);
  const saved = (await f.repository.persistence.read(66)).pilotOperations![0];
  assert.equal(saved.state, "preview");
});
test("provider read must match the exact order and connection; confirmed observation is retained", async () => {
  const f = await fixture(); await f.ready(); const p = await f.preview();
  const guid = p.operation!.workOrderGuid;
  f.orders.get(guid)!.ID = randomUUID();
  await assert.rejects(executePilot(send(p.operation!.id), f.deps), /Exact order\/customer\/vehicle/);
  f.orders.get(guid)!.ID = guid;
  f.deps.provider.connection = async () => connectionHash("other-connection");
  await assert.rejects(executePilot(send(p.operation!.id), f.deps), /connection changed/);
  assert.equal(f.sends, 0);
  f.deps.provider.connection = async () => connectionHash("synthetic-connection");
  await executePilot(send(p.operation!.id), f.deps);
  const confirmed = (await pilotStatus("visit-one", f.deps)).operation!;
  assert.ok(confirmed.confirmedAt);
  f.deps.provider.read = async () => {throw Error("Read unavailable");};
  await executePilot({action: "reconcile", visitId: "visit-one"}, f.deps);
  assert.equal((await pilotStatus("visit-one", f.deps)).operation!.confirmedAt, confirmed.confirmedAt);
  assert.equal(f.sends, 1);
});
