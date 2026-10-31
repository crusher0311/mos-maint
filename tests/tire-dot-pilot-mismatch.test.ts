import test from "node:test";
import assert from "node:assert/strict";
import { pilotHash } from "../lib/tire-dot-pilot";
import { describePilotMismatch } from "../lib/tire-dot-pilot-mismatch";

function compare(a: any, b: any, expected = 8, observed = 8, inMonth = true) {
  return describePilotMismatch({data: a, hash: pilotHash(a), page: expected, inMonth},
    {data: b, hash: pilotHash(b)}, observed);
}
test("mismatch diagnostics identify fields but never include sensitive values", () => {
  const before = {updatedDate: "old-private", vin: "private-vin", jobs: [{id: 1, authorized: null,
    parts: [{id: 2, dotNumbers: ["private-dot"], description: "private-description", quantity: 2}]}]};
  const after = structuredClone(before);
  after.updatedDate = "new-private";
  after.jobs[0].parts[0].dotNumbers = [];
  const result = compare(before, after);
  assert.deepEqual(result.changedPaths, ["invoice.updatedDate", "invoice.jobs[0].parts[0].dotNumbers.length"]);
  assert.equal(result.contentChanged, true);
  assert.equal(result.pageChanged, false);
  for (const secret of ["old-private", "new-private", "private-vin", "private-dot", "private-description"])
    assert.ok(!JSON.stringify(result).includes(secret));
  const unknown = compare({"private-property-name": "a"}, {"private-property-name": "b"});
  assert.deepEqual(unknown.changedPaths, ["invoice.otherFields"]);
  assert.ok(!JSON.stringify(unknown).includes("private-property-name"));
});
test("missing baseline, moved page, omitted DOTs, order, null and reduced evidence stay distinct", () => {
  const data = {jobs: [{id: 1, authorized: null, parts: [{id: 2, dotNumbers: []}]}]};
  const missing = describePilotMismatch(null, {data, hash: pilotHash(data)}, 8);
  assert.equal(missing.fieldComparison, "baseline_missing");
  assert.equal(missing.baselineFound, false);
  const moved = compare(data, data, 7, 8);
  assert.equal(moved.pageChanged, true); assert.equal(moved.contentChanged, false);
  const omitted = {jobs: [{id: 1, authorized: false, parts: [{id: 2}]}]};
  assert.deepEqual(compare(data, omitted).changedPaths,
    ["invoice.jobs[0].authorized", "invoice.jobs[0].parts[0].dotNumbers"]);
  assert.ok(compare({jobs: [{id: 1}, {id: 2}]}, {jobs: [{id: 2}, {id: 1}]}).contentChanged);
  const reduced = compare({id: 1}, data, 8, 8, false);
  assert.equal(reduced.fieldComparison, "baseline_reduced"); assert.deepEqual(reduced.changedPaths, []);
});
test("diagnostics cap field count and traversal work", () => {
  const many = Array.from({length: 3000}, (_, id) => ({id, authorized: true}));
  const changed = many.map(j => ({...j, authorized: false}));
  const output = compare({jobs: many}, {jobs: changed});
  assert.ok(output.changedPaths.length <= 24); assert.equal(output.truncated, true);
  assert.ok(JSON.stringify(output).length < 4000);
  const tail = structuredClone(many); tail[2999].authorized = false;
  assert.equal(compare({jobs: many}, {jobs: tail}).truncated, true);
});
