import test from "node:test";
import assert from "node:assert/strict";
import {inspectionHistory, type HistoryDependencies} from "../lib/auto-dvi/staff/history";
import {hasVisitExportIdentity} from "../lib/auto-dvi/staff/export-boundary";
import {emptyBoard} from "../lib/shop-dispatch/model";
import {syntheticVisit} from "./helpers/staff-inspection-fixture";
const vin = "1HGCM82633A004352";
function fixture() {
  let allowed = true;
  const board = emptyBoard(), visit = syntheticVisit("selected");
  visit.intake = {details: {newVehicle: {vin}}} as any;
  board.visits.push(visit);
  const access = {shopId: 1, actor: "staff", enabled: false, canEdit: false, canReview: false, config: null};
  const deps = {staff: {access: async () => {if (!allowed) throw Error("revoked"); return access;},
    board: {read: async () => structuredClone(board)}, repository: {read: async () => null}},
    vehicle: async () => {throw Error("No provider probe permitted");},
    legacy: async (shop: number, value: string) => {
      assert.equal(shop, 1); assert.equal(value, vin);
      return {updatedAt: new Date("2026-01-01"), items: [{itemId: "old", name: "Historical tire", rating: "red",
        notes: "Prior observation", recommendation: "Prior proposal", media: [{mediaId: "a".repeat(24), kind: "video", filename: "old.mp4"}]}]};
    },
    intermediate: async () => ({revision: 1, visits: []}),
  } as unknown as HistoryDependencies;
  return {deps, board, revoke: () => {allowed = false;}};
}
test("read-only history remains available when admissions are off and cannot mutate current findings", async () => {
  const f = fixture(), before = structuredClone(f.board);
  const result = await inspectionHistory("selected", f.deps);
  assert.equal(result.rows[0].source, "Legacy VIN-level Auto DVI");
  assert.equal(result.rows[0].items[0].media[0].kind, "video");
  assert.deepEqual(f.board, before);
  await assert.rejects(inspectionHistory("guessed", f.deps), /not found/);
});
test("history revalidates membership after reads; no current VIN means no history inference", async () => {
  const f = fixture();
  f.deps.intermediate = async () => {f.revoke(); return {revision: 0, visits: []};};
  await assert.rejects(inspectionHistory("selected", f.deps), /revoked/);
  const g = fixture(); delete g.board.visits[0].intake;
  await assert.rejects(inspectionHistory("selected", g.deps), /Canonical VIN/);
});
test("both legacy channels reject visit-stamped requests without changing ordinary recovery identity", () => {
  for (const key of ["visitId", "workflowVisitId", "evidenceRevision", "inspectionRevision"])
    assert.equal(hasVisitExportIdentity({[key]: null}), true);
  assert.equal(hasVisitExportIdentity({vin, operationId: "retained-operation", requestId: "retained-request"}), false);
});
test("imported provider findings are allow-listed reference text, not executable links or current results", async () => {
  const f = fixture();
  f.deps.imported = async () => ({vin, source: "autoflow", categories: [{items: [{name: "Brake", status: "red",
    notes: "Historical", pictures: ["https://untrusted.invalid/private"], raw: "PRIVATE"}]}]});
  const result = await inspectionHistory("selected", f.deps);
  assert.equal(result.rows.at(-1)!.items[0].notes, "Historical");
  assert.ok(!JSON.stringify(result).includes("untrusted.invalid"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});
