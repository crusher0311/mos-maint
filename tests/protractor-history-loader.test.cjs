const test = require("node:test");
const assert = require("node:assert/strict");
const cjs = require("../lib/integrations/protractor/fleet-history-context.ts");
const permit = id => ({ shopId: id, owner: `fixture-${id}`, revision: "fixture",
  generation: "fixture", binding: "0".repeat(64), horizonYears: 2 });

test("native and CJS scopes propagate in both directions without leaking permits", async () => {
  const imported = await import("../lib/integrations/protractor/fleet-history-context.ts");
  const native = imported.default || imported;
  assert.equal(native.getFleetHistoryContext(), undefined);
  await assert.rejects(() => native.assertFleetHistoryContext(), /context invalid/);
  await cjs.withFleetHistory(permit(1), async () => {
    assert.equal(native.getFleetHistoryContext()?.shopId, 1);
    await assert.rejects(() => native.assertFleetHistoryContext(2), /context invalid/);
    await native.withFleetHistory(permit(2), async () => {
      assert.equal(cjs.getFleetHistoryContext()?.shopId, 2);
    });
    assert.equal(native.getFleetHistoryContext()?.shopId, 1);
  });
  assert.equal(cjs.getFleetHistoryContext(), undefined);
  assert.equal(native.getFleetHistoryContext(), undefined);
  await Promise.all([1, 2].map(id => cjs.withFleetHistory(permit(id), async () => {
    await new Promise(r => setTimeout(r, 10));
    assert.equal(native.getFleetHistoryContext()?.shopId, id);
  })));
  let release;
  const later = new Promise(r => { release = r; });
  let deferred;
  await cjs.withFleetHistory(permit(3), async () => {
    deferred = later.then(async () => {
      assert.equal(native.getFleetHistoryContext()?.active, false);
      await assert.rejects(() => native.assertFleetHistoryContext(), /context invalid/);
    });
  });
  release();
  await deferred;
  let captured;
  await assert.rejects(() => native.withFleetHistory(permit(4), async () => {
    captured = cjs.getFleetHistoryContext();
    throw Error("fixture failure");
  }), /fixture failure/);
  assert.equal(captured.active, false);
  assert.equal(cjs.getFleetHistoryContext(), undefined);
});
