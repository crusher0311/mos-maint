import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyBoard, type Board, type Intake } from "../lib/shop-dispatch/model";
import { executeIntake, type IntakeDependencies } from "../lib/shop-dispatch/intake-service";
import type { IntakeDetails } from "../lib/shop-dispatch/intake-types";
import { bindWorkflowInspection, type BindingDependencies } from "../lib/auto-dvi/workflow-binding";
import { applyBindingAdmission } from "../lib/auto-dvi/workflow-binding-state";
import type { WorkflowInspection } from "../lib/auto-dvi/workflow-binding-contract";
import { effectiveInspectionPermission, type InspectionAuthority } from "../lib/auto-dvi/workflow-policy";
import { VISIT_DVI_RELEASE_ENABLED } from "../lib/auto-dvi/visit-release";

const now = "2026-10-18T12:00:00.000Z";
const guid = "33333333-3333-4333-8333-333333333333";
const details: IntakeDetails = {
  customer: "Synthetic", vehicle: "Repeated VIN 1HGCM82633A004352", contactId: "11111111-1111-4111-8111-111111111111",
  vehicleId: "22222222-2222-4222-8222-222222222222", newCustomer: null, newVehicle: null,
  identityConfirmed: true, concerns: ["Synthetic concern"], mileage: null, customerPlan: "unknown",
  neededBy: null, promiseAt: null, nextUpdateAt: null, commitmentsConfirmed: false,
};
function harness() {
  const boards = new Map<number, Board>();
  const records: WorkflowInspection[] = [];
  let boardFault = "", inspectionFault = "", member = true, available = false, writes = 0;
  const p = (shopId = 10) => ({ shopId, email: "staff@example.test", role: "manager" });
  const authority = (shopId = 10): InspectionAuthority => ({
    actorId: "staff-opaque-id", currentShopId: shopId, member, roles: ["manager"],
    enterprise: {}, enterpriseGoverned: [], local: {}, individual: {},
  });
  const workflow = {
    read: async (shop: number) => structuredClone(boards.get(shop) ?? emptyBoard()),
    save: async (shop: number, rev: number, board: Board) => {
      if ((boards.get(shop)?.revision ?? 0) !== rev) return false;
      if (boardFault === "before") { boardFault = ""; throw Error("before"); }
      boards.set(shop, structuredClone(board));
      if (boardFault === "after") { boardFault = ""; throw Error("after"); }
      return true;
    },
  };
  const intake: IntakeDependencies = {
    ...workflow, now: () => now, verifyIdentity: async () => {},
    byNumber: async () => ({ sourceId: guid, ro: "77", vehicle: details.vehicle, customer: details.customer, sourceStatus: "Open", jobs: [] }),
    confirmEntity: async () => true,
    confirm: async (_shop, op) => available ? ({
      intake: { sourceId: op.workOrderId, ro: "77", vehicle: details.vehicle, customer: details.customer, sourceStatus: "Open",
        jobs: [{ sourceId: "package", title: "Synthetic concern", bookMinutes: null }] } satisfies Intake,
      packages: [{ jobId: `${op.visitId}:intake:0`, sourceId: "package" }],
    }) : null,
    write: async () => { writes++; throw Error("lost upstream acknowledgment"); },
  };
  const deps: BindingDependencies = {
    workflow, now: () => now, authority: async principal => authority(principal.shopId),
    inspections: {
      read: async (shop, visit) => structuredClone(records.find(r => r.identity.shopId === shop && r.identity.workflowVisitId === visit) ?? null),
      commit: async admission => {
        if (inspectionFault === "before") { inspectionFault = ""; throw Error("before"); }
        const next = applyBindingAdmission(records, admission);
        if (!next) return "conflict";
        const i = records.findIndex(r => r.identity.shopId === next.identity.shopId && r.identity.workflowVisitId === next.identity.workflowVisitId);
        if (i < 0) records.push(next); else records[i] = next;
        if (inspectionFault === "after") { inspectionFault = ""; throw Error("after"); }
        return "confirmed";
      },
    },
  };
  async function checkIn(shop = 10) {
    const board = await executeIntake(p(shop), { action: "checkIn", requestId: randomUUID(),
      revision: (await workflow.read(shop)).revision, appointmentId: null, details }, intake);
    return board.visits.at(-1)!.id;
  }
  async function request(visit: string, shopId = 10) {
    return { version: 1, requestId: randomUUID(), shopId, workflowVisitId: visit,
      expectedBoardRevision: (await workflow.read(shopId)).revision,
      expectedInspectionRevision: (await deps.inspections.read(shopId, visit))?.revision ?? 0 };
  }
  return { boards, records, p, deps, intake, checkIn, request, authority, writes: () => writes,
    fault: (store: "board" | "inspection", when: string) => { if (store === "board") boardFault = when; else inspectionFault = when; },
    revoke: () => { member = false; }, confirm: () => { available = true; } };
}
test("same VIN/RO and even provider GUID across shops do not share a binding", async () => {
  const h = harness();
  for (const shop of [10, 20]) {
    const id = await h.checkIn(shop);
    await executeIntake(h.p(shop), { action: "link", requestId: randomUUID(), revision: h.boards.get(shop)!.revision,
      visitId: id, roNumber: "77", expectedSourceId: guid, confirmed: true }, h.intake);
    assert.equal((await bindWorkflowInspection(h.p(shop), await h.request(id, shop), h.deps)).status, "confirmed");
  }
  assert.equal(h.records.length, 2);
  const first = h.records[0];
  h.boards.get(10)!.visits[0].closed = true;
  const repeated = await h.checkIn();
  assert.notEqual(repeated, first.identity.workflowVisitId);
  assert.equal((await bindWorkflowInspection(h.p(), await h.request(repeated), h.deps)).status, "confirmed");
  assert.equal(h.records.length, 3);
});
for (const store of ["board", "inspection"] as const) for (const when of ["before", "after"]) {
  test(`lost ${store} acknowledgment ${when} commit recovers exactly one binding`, async () => {
    const h = harness(), id = await h.checkIn(), req = await h.request(id);
    h.fault(store, when);
    const first = await bindWorkflowInspection(h.p(), req, h.deps);
    assert.ok(["confirmed", "pending-local-finalization"].includes(first.status));
    const retry = await bindWorkflowInspection(h.p(), req, h.deps);
    assert.equal(retry.status, "confirmed");
    assert.equal(h.records.length, 1); assert.equal(h.records[0].revision, 1);
    assert.equal(h.records[0].events.length, 1);
    assert.equal(h.boards.get(10)!.dviAdmissions!.length, 1);
    assert.equal((await bindWorkflowInspection(h.p(), { ...req, expectedInspectionRevision: 7 }, h.deps)).status, "conflict");
  });
}
test("concurrent staff: one admission, no overwrite of inspection evidence", async () => {
  const h = harness(), id = await h.checkIn(), req = await h.request(id);
  const outcomes = await Promise.all([bindWorkflowInspection(h.p(), req, h.deps),
    bindWorkflowInspection(h.p(), { ...req, requestId: randomUUID() }, h.deps)]);
  assert.deepEqual(outcomes.map(o => o.status).sort(), ["confirmed", "conflict"]);
  h.records[0].results = { tire: { notes: "retain" } }; h.records[0].revision++;
  assert.equal((await bindWorkflowInspection(h.p(), req, h.deps)).status, "confirmed");
  assert.deepEqual(h.records[0].results, { tire: { notes: "retain" } });
});
test("existing intake exact-ID recovery never replays an uncertain ticket stage", async () => {
  const h = harness(), id = await h.checkIn();
  const initial = await h.request(id);
  await bindWorkflowInspection(h.p(), initial, h.deps);
  await executeIntake(h.p(), { action: "create", requestId: randomUUID(), revision: h.boards.get(10)!.revision, visitId: id, confirmed: true }, h.intake);
  assert.equal(h.writes(), 1);
  await assert.rejects(bindWorkflowInspection(h.p(), await h.request(id), h.deps), /exact-ID/);
  await executeIntake(h.p(), { action: "reconcile", visitId: id }, h.intake);
  assert.equal(h.writes(), 1);
  h.confirm();
  await executeIntake(h.p(), { action: "reconcile", visitId: id }, h.intake);
  assert.equal(h.writes(), 1);
  assert.equal((await bindWorkflowInspection(h.p(), await h.request(id), h.deps)).status, "confirmed");
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].identity.workflowVisitId, id);
  assert.equal(h.records[0].identity.providerWorkOrderId, h.boards.get(10)!.ticketIntents![0].workOrderId);
});
test("import merge retains alias; imported inspection binding prevents destructive merge", async () => {
  for (const alreadyBound of [false, true]) {
    const h = harness(), local = await h.checkIn();
    const board = h.boards.get(10)!;
    board.visits.push({ ...structuredClone(board.visits[0]), id: "imported", intake: undefined,
      arrivalAt: null, provider: "protractor", sourceId: guid });
    if (alreadyBound) await bindWorkflowInspection(h.p(), await h.request("imported"), h.deps);
    const link = () => executeIntake(h.p(), { action: "link", requestId: randomUUID(), revision: h.boards.get(10)!.revision,
      visitId: local, roNumber: "77", expectedSourceId: guid, confirmed: true }, h.intake);
    if (alreadyBound) { await assert.rejects(link(), /inspection reconciliation/); continue; }
    await link();
    await bindWorkflowInspection(h.p(), await h.request(local), h.deps);
    assert.deepEqual(h.records[0].aliases, ["imported"]);
    assert.equal(h.records[0].events[1].reason, "import-alias");
    await assert.rejects(bindWorkflowInspection(h.p(), await h.request("imported"), h.deps), /Open workflow/);
  }
});
test("membership, cross-shop, closed visits and guessed attachment input fail closed", async () => {
  const h = harness(), id = await h.checkIn(), req = await h.request(id);
  await assert.rejects(bindWorkflowInspection(h.p(20), req, h.deps), /Current-shop/);
  await assert.rejects(bindWorkflowInspection(h.p(), { ...req, mediaId: "guessed" }, h.deps));
  h.boards.get(10)!.visits[0].closed = true;
  await assert.rejects(bindWorkflowInspection(h.p(), req, h.deps), /Open workflow/);
  h.boards.get(10)!.visits[0].closed = false;
  await bindWorkflowInspection(h.p(), req, h.deps);
  h.revoke();
  await assert.rejects(bindWorkflowInspection(h.p(), req, h.deps), /Current-shop/);
  assert.ok(!JSON.stringify(h.records[0].events).includes("Synthetic"));
  assert.equal(VISIT_DVI_RELEASE_ENABLED, false);
});
test("permission precedence: technician publication denial cannot be overridden", () => {
  const h = harness(), a = h.authority();
  a.roles = ["technician", "manager"]; a.individual.publish = "allow"; a.enterprise.publish = "allow";
  assert.equal(effectiveInspectionPermission(a, 10, "publish").source, "technician-publication-denial");
  assert.equal(effectiveInspectionPermission(a, 10, "edit").allowed, true);
  a.individual.edit = "deny"; a.local.edit = "allow";
  assert.equal(effectiveInspectionPermission(a, 10, "edit").allowed, false);
  a.roles = ["technician"];
  assert.equal(effectiveInspectionPermission(a, 10, "sensitive").allowed, false);
  a.local.sensitive = "allow"; a.enterpriseGoverned = ["sensitive"];
  assert.equal(effectiveInspectionPermission(a, 10, "sensitive").allowed, false);
  a.enterprise.sensitive = "allow";
  assert.equal(effectiveInspectionPermission(a, 10, "sensitive").allowed, true);
  a.individual.sensitive = "deny";
  assert.equal(effectiveInspectionPermission(a, 10, "sensitive").allowed, false);
});
test("pending local admission blocks competing request; stale inspection cannot erase work", async () => {
  const h = harness(), id = await h.checkIn(), req = await h.request(id);
  h.fault("inspection", "before");
  assert.equal((await bindWorkflowInspection(h.p(), req, h.deps)).status, "pending-local-finalization");
  assert.equal((await bindWorkflowInspection(h.p(), await h.request(id), h.deps)).status, "conflict");
  assert.equal((await bindWorkflowInspection(h.p(), req, h.deps)).status, "confirmed");
  const stale = await h.request(id);
  h.records[0].revision++;
  h.records[0].results = { evidence: "new work" };
  assert.equal((await bindWorkflowInspection(h.p(), stale, h.deps)).status, "conflict");
  assert.deepEqual(h.records[0].results, { evidence: "new work" });
});
test("transaction contract rejects alias collisions, provider retargeting and closed inspections", async () => {
  const h = harness(), id = await h.checkIn(), req = await h.request(id);
  await bindWorkflowInspection(h.p(), req, h.deps);
  const a = structuredClone(h.records[0].receipts[0]);
  a.requestId = randomUUID(); a.expectedInspectionRevision = 1;
  a.identity.provider = "protractor"; a.identity.providerWorkOrderId = guid;
  const upgraded = applyBindingAdmission(h.records, a)!;
  assert.ok(upgraded);
  const changed = { ...a, requestId: randomUUID(), expectedInspectionRevision: 2,
    identity: { ...a.identity, providerWorkOrderId: randomUUID() } };
  assert.equal(applyBindingAdmission([upgraded], changed), null);
  assert.equal(applyBindingAdmission([{ ...upgraded, closed: true }], { ...a, requestId: randomUUID(), expectedInspectionRevision: 2 }), null);
  assert.equal(applyBindingAdmission([upgraded], { ...a, requestId: randomUUID(), expectedInspectionRevision: 0,
    identity: { ...a.identity, workflowVisitId: "other", provider: "manual", providerWorkOrderId: null }, aliases: [id] }), null);
});
test("revocation during a receipt read denies the response", async () => {
  const h = harness(), id = await h.checkIn(), req = await h.request(id);
  await bindWorkflowInspection(h.p(), req, h.deps);
  const read = h.deps.inspections.read;
  h.deps.inspections.read = async (...args) => { const result = await read(...args); h.revoke(); return result; };
  await assert.rejects(bindWorkflowInspection(h.p(), req, h.deps), /Current-shop/);
});
