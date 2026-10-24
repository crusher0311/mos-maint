import test from "node:test";
import assert from "node:assert/strict";
import { applyStaffCommand, blankFinding, initialInspection, missingFor, missingRequirements, sameInspectionItem,
  sheetSchema, validateFinding, type Finding, type FindingInput } from "../lib/auto-dvi/staff/model";
import { TIRE_BATTERY_SHEET } from "../lib/auto-dvi/staff/tire-battery-sheet";
import { project } from "../lib/auto-dvi/pilot/model";
const at = "2026-10-24T12:00:00.000Z";
const tire = TIRE_BATTERY_SHEET.items[0], battery = TIRE_BATTERY_SHEET.items[4];
const fullTire = (): FindingInput => ({...blankFinding(), rating: "green", notes: "Manual readings and visible condition recorded",
  values: {actualSize: "225/45R18", availability: "measured", unit: "32nds", inner: 7, center: 8, outer: 7, beforePsi: 34}});
const fullBattery = (): FindingInput => ({...blankFinding(), rating: "green", notes: "Technician confirmed tester result",
  values: {rated: 760, measured: 100, ratedStandard: "CCA", measuredStandard: "CCA", outcome: "pass"}});
const saved = (input: FindingInput): Finding => ({...input, photos: [], actor: "technician", at});
function completed() {
  let s = initialInspection(TIRE_BATTERY_SHEET);
  for (const item of TIRE_BATTERY_SHEET.items) s = applyStaffCommand(s, {type: "save", sheet: "tire-battery@1",
    item: item.id, finding: item.capture === "tire-v1" ? fullTire() : fullBattery()}, [], "tech", at, false);
  return s;
}
test("candidate sheet starts blank, four positions distinct, all green requirements retained", () => {
  const s = initialInspection(TIRE_BATTERY_SHEET);
  assert.deepEqual(s.sheets[0].results, {});
  assert.equal(missingRequirements(s).length, 5);
  const done = completed();
  assert.deepEqual(missingRequirements(done), []);
  assert.equal(done.sheets[0].results["tire.lf"].values.afterPsi, undefined);
  assert.equal(done.sheets[0].results.battery.values.outcome, "pass"); // no ratio inference
  assert.equal(sameInspectionItem(tire, TIRE_BATTERY_SHEET.items[1]), false);
  assert.equal(missingFor(tire, saved({...fullTire(), notes: ""}))[0], "Evaluation notes");
});
test("explicit units, independent pressure, matching battery standards and reasoned unavailability", () => {
  for (const values of [{unit: "mm", inner: 26}, {inner: -1}, {afterPsi: 121}, {beforePsi: 0}])
    assert.throws(() => validateFinding(tire, {...fullTire(), values: {...fullTire().values, ...values}}));
  assert.ok(missingFor(tire, saved({...fullTire(), values: {actualSize: "225/45R18", availability: "measured"}})).length);
  assert.deepEqual(missingFor(tire, saved({...fullTire(), values: {actualSize: "225/45R18", availability: "unable-to-measure", reason: "Valve inaccessible"}})), []);
  assert.ok(missingFor(battery, saved({...fullBattery(), values: {...fullBattery().values, measuredStandard: "EN"}})).length);
  assert.ok(missingFor(battery, saved({...fullBattery(), values: {outcome: "not-tested"}})).length);
  assert.ok(missingFor(battery, saved({...fullBattery(), values: {outcome: "unable-to-test"}})).length);
  assert.deepEqual(missingFor(battery, saved({...fullBattery(), values: {outcome: "unable-to-test", reason: "Tester not available"}})), []);
  assert.ok(missingFor(tire, saved({...fullTire(), rating: "na", naReason: ""})).length);
});
test("same-visit matching reuse only; sheet snapshots and previous published content stay unchanged", () => {
  let s = completed();
  s = applyStaffCommand(s, {type: "review"}, [], "advisor", at, true);
  const published = structuredClone(s);
  const alternate = sheetSchema.parse({...TIRE_BATTERY_SHEET, id: "alternate", name: "Alternate"});
  s = applyStaffCommand(s, {type: "select", sheet: "alternate@1", keepActive: true}, [alternate], "tech", at, false);
  assert.deepEqual(s.sheets[0].results, s.sheets[1].results);
  s = applyStaffCommand(s, {type: "save", sheet: "alternate@1", item: tire.id, finding: {...fullTire(), values: {...fullTire().values, actualSize: "255/40R18"}}}, [], "tech", at, false);
  assert.equal(s.sheets[0].results[tire.id].values.actualSize, "255/40R18");
  assert.equal(s.sheets[0].results["tire.rf"].values.actualSize, "225/45R18");
  assert.notEqual(s.reviewed?.revision, s.evidenceRevision);
  assert.equal(published.sheets[0].results[tire.id].values.actualSize, "225/45R18");
  assert.deepEqual(initialInspection(alternate).sheets[0].results, {});
  assert.equal(sameInspectionItem(tire, {...tire, capture: undefined}), false);
});
test("confirmed scope suggestions deduplicate without ever marking inspected", () => {
  let s = initialInspection(TIRE_BATTERY_SHEET);
  const check = {id: "check-one", name: "Oil inspection", source: "vhi" as const, reference: "vhi:engine_oil"};
  s = applyStaffCommand(s, {type: "add-checks", items: [check, check]}, [], "tech", at, false);
  assert.equal(s.sheets[1].sheet.items.length, 1);
  assert.deepEqual(s.sheets[1].results, {});
  assert.equal(s.startedAt, null);
  assert.throws(() => applyStaffCommand(s, {type: "add-checks", items: [check]}, [], "tech", at, false), /already present/);
  assert.equal(initialInspection(TIRE_BATTERY_SHEET).sheets.length, 1);
});
test("provider projection uses selected visit evidence including green, never legacy data", () => {
  const s = completed();
  const selection = TIRE_BATTERY_SHEET.items.map(i => ({sheet: "tire-battery@1", item: i.id}));
  const lines = project(s, selection, {green: "OK", yellow: "Monitor", red: "Required"});
  assert.equal(lines.length, 5);
  assert.ok(lines.every(l => l.result === "OK"));
  assert.ok(lines[0].notes.includes("Actual tire size: 225/45R18"));
  assert.throws(() => project(initialInspection(TIRE_BATTERY_SHEET), selection, {green: "OK", yellow: "Monitor", red: "Required"}), /evaluated/);
});
test("proposals are separately persisted, advisor-only and stale after evidence edits; no pricing enters provider findings", () => {
  let s = completed();
  s = applyStaffCommand(s, {type: "save", sheet: "tire-battery@1", item: tire.id,
    finding: {...fullTire(), recommendation: "Replace tire"}}, [], "tech", at, false);
  const proposal = {type: "proposal" as const, id: "tire-battery@1/tire.lf", title: "Replace tire", hours: 0.8, rate: 119.5, basis: "manual" as const, remove: false};
  assert.throws(() => applyStaffCommand(s, proposal, [], "tech", at, false), /permission/);
  s = applyStaffCommand(s, {type: "review"}, [], "advisor", at, true);
  const evidence = s.evidenceRevision;
  s = applyStaffCommand(s, proposal, [], "advisor", at, true);
  assert.equal(s.evidenceRevision, evidence);
  assert.equal(s.reviewed, null);
  assert.equal(s.proposals![0].status, "proposed");
  const lines = project(s, [{sheet: "tire-battery@1", item: tire.id}], {green: "OK", yellow: "Monitor", red: "Required"});
  assert.ok(!JSON.stringify(lines).includes("119.5"));
  s = applyStaffCommand(s, {type: "save", sheet: "tire-battery@1", item: tire.id,
    finding: {...fullTire(), recommendation: "Recheck tire"}}, [], "tech", at, false);
  assert.throws(() => applyStaffCommand(s, {type: "review"}, [], "advisor", at, true), /Reconfirm/);
  s = applyStaffCommand(s, {...proposal, remove: true}, [], "advisor", at, true);
  assert.equal(s.proposals!.length, 0);
});
