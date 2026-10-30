import test from "node:test";
import assert from "node:assert/strict";
import { reconciliationHash, reconciliationWindow, removedSourceIds,
  validateReconciliationDetail } from "../lib/integrations/tekmetric/reconciliation-policy";
const scope = { shopId: 1, providerShopId: 10, timezone: "America/Chicago",
  startHour: 1, endHour: 5, enabled: true };
const raw = () => ({ id: 100, shopId: 10, repairOrderNumber: 20,
  updatedDate: "2026-10-01T12:00:00Z",
  jobs: [{ id: 1, parts: [{ id: 2, dotNumbers: ["001", "001"] }], labor: [] }],
  payments: [] });
test("overnight boundaries use shop timezone, including DST and midnight windows", () => {
  assert.equal(reconciliationWindow(scope, new Date("2026-10-01T06:00:00Z")), true);
  assert.equal(reconciliationWindow(scope, new Date("2026-10-01T10:00:00Z")), false);
  assert.equal(reconciliationWindow(scope, new Date("2026-12-01T06:00:00Z")), false);
  assert.equal(reconciliationWindow(scope, new Date("2026-12-01T07:00:00Z")), true);
  assert.equal(reconciliationWindow({ ...scope, startHour: 23, endHour: 3 },
    new Date("2026-10-01T05:00:00Z")), true);
  assert.equal(reconciliationWindow({ ...scope, timezone: "invalid" }, new Date()), false);
  assert.equal(reconciliationWindow({ ...scope, enabled: false }, new Date()), false);
});
test("complete detail validates scope and explicit empty children, not omissions", () => {
  validateReconciliationDetail(scope, 100, raw());
  assert.throws(() => validateReconciliationDetail(scope, 101, raw()));
  assert.throws(() => validateReconciliationDetail({ ...scope, providerShopId: 11 }, 100, raw()));
  assert.throws(() => validateReconciliationDetail(scope, 100, { ...raw(), jobs: undefined }));
  assert.throws(() => validateReconciliationDetail(scope, 100, { ...raw(), payments: undefined }));
  assert.throws(() => validateReconciliationDetail(scope, 100, { ...raw(),
    jobs: [{ id: 1, parts: [], labor: undefined }] }));
  assert.throws(() => validateReconciliationDetail(scope, 100, { ...raw(),
    jobs: [{ id: 1, parts: [], labor: [] }, { id: 1, parts: [], labor: [] }] }));
  validateReconciliationDetail(scope, 100, { ...raw(), jobs: [] });
});
test("full evidence changes are detected; DOT occurrences remain significant", () => {
  assert.equal(reconciliationHash({ a: 1, b: 2 }), reconciliationHash({ b: 2, a: 1 }));
  const changed = raw(); changed.jobs[0].parts[0].dotNumbers.pop();
  assert.notEqual(reconciliationHash(raw()), reconciliationHash(changed));
  assert.notEqual(reconciliationHash(raw()), reconciliationHash({ ...raw(), milesIn: 10 }));
  assert.deepEqual(removedSourceIds([{ id: 1 }, { id: 2 }], [{ id: 2 }]), [1]);
  assert.deepEqual(removedSourceIds([{ id: 1 }], []), [1]);
});
