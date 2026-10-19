import test from "node:test";
import assert from "node:assert/strict";
import { initialInspection, STAFF_SHEET_TEMPLATES, blankFinding } from "../lib/auto-dvi/staff/model";
import { projectReport, type ReleaseSelection } from "../lib/auto-dvi/release/model";

const branding = {name: "Synthetic shop", phone: "", primary: "#123456", logo: null};
function fixture() {
  const inspection = initialInspection(STAFF_SHEET_TEMPLATES[0]);
  const sheet = inspection.sheets[0];
  const item = sheet.sheet.items[0];
  sheet.results[item.id] = {...blankFinding(), rating: "yellow", notes: "INTERNAL ONLY",
    recommendation: "STAFF ONLY", values: {inner: 4, unit: "mm"}, photos: [], actor: "PRIVATE ACTOR", at: "2026-10-19T00:00:00.000Z"};
  const selection: ReleaseSelection = {findings: [{sheet: sheet.key, item: item.id, includeInactive: false,
    customerText: "Measured tread requires attention.", nextStep: "Discuss next steps with your advisor.",
    photoIds: [], concernIds: ["concern-1"]}], acknowledgeExcludedHazards: false};
  return {inspection, sheet, item, selection};
}
test("findings-only projection preserves original measurements and customer words without private fields", () => {
  const f = fixture();
  const result = projectReport(f.inspection, f.selection, [{id: "concern-1", words: "I hear a noise"}], branding);
  assert.equal(result.report.progress, "inspection-in-progress");
  assert.equal(result.report.concerns[0].words, "I hear a noise");
  assert.ok(result.report.findings[0].measurements.some(v => v.value === "mm"));
  const publicJson = JSON.stringify(result.report);
  for (const value of ["INTERNAL ONLY", "STAFF ONLY", "PRIVATE ACTOR", "naReason", "photos", "actor"])
    assert.equal(publicJson.includes(value), false);
});
test("inactive inclusion, N/A, unknown photos, unknown concern and duplicate identities fail closed", () => {
  const f = fixture();
  const project = () => projectReport(f.inspection, f.selection, [{id: "concern-1", words: "Noise"}], branding);
  f.sheet.active = false;
  assert.throws(project, /inactive/);
  f.selection.findings[0].includeInactive = true;
  project();
  f.sheet.results[f.item.id].rating = "na";
  assert.throws(project, /non-N\/A/);
  f.sheet.results[f.item.id].rating = "green";
  f.selection.findings[0].photoIds = ["a".repeat(24)];
  assert.throws(project, /committed photos/);
  f.selection.findings[0].photoIds = [];
  f.selection.findings[0].concernIds = ["guessed"];
  assert.throws(project, /concern associations/);
  f.selection.findings[0].concernIds = [];
  f.selection.findings.push({...f.selection.findings[0]});
  assert.throws(project, /Duplicate/);
});
test("selected evidence changes are distinguishable from unrelated edits; hazards include inactive sheets", () => {
  const f = fixture();
  const project = () => projectReport(f.inspection, f.selection, [{id: "concern-1", words: "Noise"}], branding);
  const before = project();
  const second = f.sheet.sheet.items[1];
  f.sheet.results[second.id] = {...f.sheet.results[f.item.id], rating: "red"};
  const after = project();
  assert.deepEqual(after.selectedEvidence, before.selectedEvidence);
  assert.equal(after.excludedHazards.length, 1);
  f.sheet.results[f.item.id].values.inner = 2;
  const innerLabel = f.item.fields.find(field => field.id === "inner")!.label;
  assert.equal(project().report.findings[0].measurements.find(m => m.label === innerLabel)?.value, 2);
  assert.notDeepEqual(project().selectedEvidence, before.selectedEvidence);
});
