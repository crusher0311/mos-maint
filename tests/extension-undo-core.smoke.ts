// Smoke test for the extension undo-snapshot pure logic (Task #1086).
// mos-tools-extension/undo-core.js is a UMD-ish classic script (content
// scripts + background import); load it here via createRequire.
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  makeUndoKey,
  pruneUndoSnapshots,
  summarizeSnapshot,
  remainingUndoItems,
  buildAutoflowRevertOps,
  UNDO_MAX_ENTRIES,
} = require("../mos-tools-extension/undo-core.js");

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

const NOW = 1_750_000_000_000;

ok("makeUndoKey is provider:shop:ro:kind", () => {
  assert.strictEqual(
    makeUndoKey({ provider: "tekmetric", shopId: 42, roId: "778", kind: "enhance_notes" }),
    "tekmetric:42:778:enhance_notes"
  );
});

ok("prune drops expired snapshots", () => {
  const map = {
    fresh: { createdAt: NOW - 1000 },
    stale: { createdAt: NOW - 25 * 60 * 60 * 1000 },
    invalid: { createdAt: "nope" },
  };
  const out = pruneUndoSnapshots(map, NOW);
  assert.deepStrictEqual(Object.keys(out), ["fresh"]);
});

ok("prune caps at newest UNDO_MAX_ENTRIES", () => {
  const map: Record<string, { createdAt: number }> = {};
  for (let i = 0; i < UNDO_MAX_ENTRIES + 10; i++) map[`k${i}`] = { createdAt: NOW - i * 1000 };
  const out = pruneUndoSnapshots(map, NOW);
  assert.strictEqual(Object.keys(out).length, UNDO_MAX_ENTRIES);
  assert.ok("k0" in out, "newest kept");
  assert.ok(!(`k${UNDO_MAX_ENTRIES + 5}` in out), "oldest dropped");
});

ok("prune handles empty/undefined maps", () => {
  assert.deepStrictEqual(pruneUndoSnapshots({}, NOW), {});
  assert.deepStrictEqual(pruneUndoSnapshots(undefined, NOW), {});
});

ok("summarize counts items per kind", () => {
  assert.strictEqual(summarizeSnapshot({ kind: "enhance_notes", items: [1, 2] }), "2 enhanced notes");
  assert.strictEqual(summarizeSnapshot({ kind: "dvi_prefill", items: [1] }), "1 pre-filled DVI item");
  assert.strictEqual(summarizeSnapshot({ kind: "add_vhi_recommendations", items: [] }), "0 added recommendations");
  // Task #1094: side-panel add-to-RO snapshots
  assert.strictEqual(summarizeSnapshot({ kind: "sidepanel_add_job", items: [1] }), "1 job added to RO");
  assert.strictEqual(summarizeSnapshot({ kind: "sidepanel_add_job", items: [1, 2] }), "2 jobs added to RO");
});

ok("partial side-panel undo keeps failed items retryable (Task #1094)", () => {
  const items = [
    { jobId: 101, name: "Oil change" },
    { jobId: "102", name: "Brakes" },
    { jobId: 103, name: "Coolant flush" },
    { name: "no id — never attempted" },
  ];
  // Mixed results: 101 deleted, "102" deleted (string/number id mismatch must
  // still match), 103 failed → 103 + the id-less item must remain stored.
  const remaining = remainingUndoItems(items, [101, 102]);
  assert.deepStrictEqual(remaining.map((it: any) => it.name), ["Coolant flush", "no id — never attempted"]);
  // Nothing reverted → everything stays.
  assert.strictEqual(remainingUndoItems(items, []).length, 4);
  // Everything reverted → only the id-less item stays.
  assert.deepStrictEqual(remainingUndoItems(items, [101, "102", 103]).map((it: any) => it.jobId), [undefined]);
  // Malformed input is safe.
  assert.deepStrictEqual(remainingUndoItems(undefined, [1]), []);
});

ok("rvh revert ops delete created entries", () => {
  const ops = buildAutoflowRevertOps({
    kind: "add_vhi_recommendations",
    roId: "9001",
    statusId: "555",
    items: [{ rvhId: 71, title: "Coolant flush" }, { rvhId: null }, { rvhId: 72 }],
  });
  assert.strictEqual(ops.length, 2, "null rvhId skipped");
  assert.deepStrictEqual(ops[0].params, { request_type: "delete_rvh", rvh_id: "71", status_id: "555" });
  assert.strictEqual(ops[0].type, "rvh_delete");
});

ok("sheet revert ops restore original status + notes", () => {
  const ops = buildAutoflowRevertOps({
    kind: "dvi_prefill",
    roId: "9001",
    statusId: "555",
    sheetId: "sh1",
    items: [
      { inspecId: 10, prevStatus: "2", prevNotes: "was fine", resultsId: "r1", techId: "t1", name: "Brakes" },
      { inspecId: 11, prevStatus: "", prevNotes: "" }, // unset status must NOT be sent
      { inspecId: null }, // skipped
    ],
  });
  assert.strictEqual(ops.length, 2);
  assert.deepStrictEqual(ops[0].params, {
    request_type: "update_sheet",
    status_id: "555",
    inspec_id: "10",
    notes: "was fine",
    inspec_status: "2",
    sheet_id: "sh1",
    results_id: "r1",
    prev_tech_id: "t1",
  });
  assert.ok(!("inspec_status" in ops[1].params), "empty prevStatus omitted (would coerce to RED)");
  assert.strictEqual(ops[1].params.notes, "");
});

ok("sheet revert falls back to roId when statusId missing", () => {
  const ops = buildAutoflowRevertOps({
    kind: "enhance_notes",
    roId: "777",
    items: [{ inspecId: 1, prevStatus: "1", prevNotes: "n" }],
  });
  assert.strictEqual(ops[0].params.status_id, "777");
});

ok("revert ops for malformed snapshots are empty", () => {
  assert.deepStrictEqual(buildAutoflowRevertOps(null), []);
  assert.deepStrictEqual(buildAutoflowRevertOps({ kind: "dvi_prefill" }), []);
});

console.log(`\nAll ${passed} extension-undo-core smoke tests passed.`);
