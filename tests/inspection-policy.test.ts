import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inspectionPolicySchema, policyAllows, type InspectionPolicy } from "../lib/auto-dvi/staff/inspection-policy";
import { initialInspection, applyStaffCommand, blankFinding, missingRequirements, assertPolicyReleaseReady, type StaffSheet } from "../lib/auto-dvi/staff/model";
import { staffStateSchema } from "../lib/auto-dvi/staff/store";
import { updateCatalog, type CatalogDependencies } from "../lib/auto-dvi/staff/sheet-catalog";
import { configurationSchema, type StaffConfiguration } from "../lib/auto-dvi/staff/configuration";
import { projectReport } from "../lib/auto-dvi/release/model";
import { project } from "../lib/auto-dvi/pilot/model";

const at = "2026-10-31T12:00:00.000Z";
const policy: InspectionPolicy = {version: 1, actor: "manager", at, completionMode: "captured-findings",
  publishRoles: ["manager"], deliverRoles: ["owner"]};
const sheet: StaffSheet = {id: "basic", version: 1, name: "Basic", items: ["one", "two"].map(id => ({
  id, name: id, procedure: id, required: true, fields: [], requiredFields: [],
  notesRequired: true, photoRequired: false, recommendationRequired: false,
}))};
const save = (state: ReturnType<typeof initialInspection>, item = "one", rating: "red" | "green" | "na" | null = "green", notes = "Observed") =>
  applyStaffCommand(state, {type: "save", sheet: "basic@1", item,
    finding: {...blankFinding(), rating, notes, naReason: rating === "na" ? "Not fitted" : ""}}, [sheet], "technician", at, false);
const review = (state: ReturnType<typeof initialInspection>) =>
  applyStaffCommand(state, {type: "review"}, [sheet], "manager", at, true);

test("old inspections retain required coverage and strict readers accept optional pinned policy", () => {
  const old = save(initialInspection(sheet));
  assert.equal(missingRequirements(old).length, 1);
  assert.equal(old.policy, undefined);
  assert.doesNotThrow(() => assertPolicyReleaseReady(old));
  assert.deepEqual(staffStateSchema.parse(old), old);
  const pinned = initialInspection(sheet, policy);
  assert.deepEqual(staffStateSchema.parse(pinned).policy, policy);
  assert.notEqual(pinned.policy, policy);
});

test("captured mode leaves unmentioned checks blank, rejects empty, N/A-only and incomplete findings", () => {
  const empty = initialInspection(sheet, policy);
  assert.ok(missingRequirements(empty).length);
  assert.ok(missingRequirements(save(empty, "one", "na")).length);
  assert.ok(missingRequirements(save(empty, "one", null)).some(m => m.message === "Rating"));
  assert.ok(missingRequirements(save(empty, "one", "green", "")).some(m => m.message === "Evaluation notes"));
  const captured = save(empty);
  assert.deepEqual(missingRequirements(captured), []);
  assert.equal(captured.sheets[0].results.two, undefined);
  assert.throws(() => assertPolicyReleaseReady(captured), /Review/);
  assert.doesNotThrow(() => assertPolicyReleaseReady(review(captured)));
  assert.throws(() => assertPolicyReleaseReady(save(review(captured))), /Review/);
});

test("item photo requirements apply independently of color and arrival photos cannot satisfy them", () => {
  const photoSheet = structuredClone(sheet); photoSheet.items[0].photoRequired = true;
  for (const rating of ["green", "red"] as const) {
    const state = save(initialInspection(photoSheet, policy), "one", rating);
    state.sheets[0].results.one.arrivalPhotos = [{id: "a".repeat(24), workOrderId: randomUUID(),
      mime: "image/png", provenance: "arrival", capturedAt: at, actor: "technician", at}];
    assert.ok(missingRequirements(state).some(m => m.message === "Photo"));
  }
});

test("publication and export use the same policy evaluator and reviewed evidence boundary", () => {
  const state = save(initialInspection(sheet, policy));
  const selection = {findings: [{sheet: "basic@1", item: "one", customerText: "Observed", nextStep: "",
    photoIds: [], concernIds: [], includeInactive: false}], acknowledgeExcludedHazards: false};
  const branding = {name: "Fixture", phone: "", primary: "#123456", logo: null};
  const labels = {green: "OK", yellow: "Monitor", red: "Required"};
  assert.throws(() => projectReport(state, selection, [], branding), /Review/);
  assert.throws(() => project(state, selection.findings, labels), /Review/);
  const reviewed = review(state);
  assert.equal(projectReport(reviewed, selection, [], branding).report.findings.length, 1);
  assert.equal(project(reviewed, selection.findings, labels).length, 1);
});

test("role policy intersects pinned and current restrictions without granting technicians access", () => {
  assert.equal(policyAllows("publish", ["technician"]), false);
  assert.equal(policyAllows("publish", ["advisor"]), true);
  assert.equal(policyAllows("publish", ["advisor"], policy), false);
  assert.equal(policyAllows("publish", ["manager"], policy), true);
  assert.equal(policyAllows("deliver", ["manager"], policy), false);
  assert.equal(policyAllows("publish", ["manager"], policy, {...policy, publishRoles: []}), false);
  assert.equal(policyAllows("publish", ["advisor"], policy, {...policy, publishRoles: ["advisor"]}), false);
  assert.equal(inspectionPolicySchema.safeParse({...policy, publishRoles: ["technician"]}).success, false);
  assert.equal(inspectionPolicySchema.safeParse({...policy, publishRoles: ["manager", "manager"]}).success, false);
});

test("manager save is current-shop scoped, explicit, receipted and does not alter gates or pinned evidence", async () => {
  let config: StaffConfiguration | null = configurationSchema.parse({version: 1, enabledShopIds: [],
    sheets: [sheet], defaultSheet: "basic@1", rules: {}, individual: {}});
  let canManage = true, rejectCAS = false;
  const deps: CatalogDependencies = {
    access: async () => ({key: "enterprise:fixture", shopId: 66, actor: "manager", scope: "enterprise", scopeLabel: "Fixture", canManage}),
    now: () => at,
    store: {read: async () => structuredClone(config),
      cas: async (_key, _before, after) => {if (rejectCAS) return false; config = structuredClone(after); return true;}},
  };
  const {version: _, actor: __, at: ___, ...draft} = policy;
  const request = {requestId: randomUUID(), revision: 0, command: {type: "policy", policy: draft}};
  canManage = false;
  await assert.rejects(updateCatalog(request, deps), /authorized managers/);
  canManage = true;
  const first = await updateCatalog(request, deps);
  assert.deepEqual(first.policy, policy);
  const pinned = initialInspection(sheet, first.policy!);
  assert.deepEqual((await updateCatalog(request, deps)).policy, first.policy);
  assert.deepEqual(config!.enabledShopIds, []);
  assert.equal(config!.release, undefined);
  assert.equal(config!.pilot, undefined);
  assert.deepEqual(Object.keys(config!.policies!), ["66"]);
  const changed = {...request, requestId: randomUUID(), revision: 1,
    command: {type: "policy", policy: {...draft, completionMode: "required-checks"}}};
  rejectCAS = true;
  await assert.rejects(updateCatalog(changed, deps), /concurrently/);
  assert.equal(config!.policies!["66"].version, 1);
  rejectCAS = false;
  const second = await updateCatalog(changed, deps);
  assert.equal(second.policy!.version, 2);
  assert.equal(pinned.policy!.completionMode, "captured-findings");
  await assert.rejects(updateCatalog({...changed, requestId: randomUUID()}, deps), /changed/);
});
