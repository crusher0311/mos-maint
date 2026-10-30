import test from "node:test";
import assert from "node:assert/strict";
import { reconcileTick, type ReconciliationDependencies } from "../lib/integrations/tekmetric/reconciliation-engine";
const raw = { id: 100, shopId: 10, repairOrderNumber: 1,
  updatedDate: "2026-10-01T00:00:00Z", jobs: [], payments: [] };
function fixture() {
  let count = 0;
  const evidence = { requests: 0, replacements: 0, completion: "", deferred: "", exception: "" };
  const deps: ReconciliationDependencies = {
    now: () => new Date("2026-10-01T07:00:00Z"),
    scope: async () => ({ shopId: 1, providerShopId: 10, timezone: "America/Chicago",
      startHour: 1, endHour: 5, enabled: true }),
    claim: async () => count++ === 0 ? { id: "a", shopId: 1, providerShopId: 10,
      roId: 100, expectedRevision: "old", attempt: 1 } : null,
    acquireBackgroundSlot: async () => true,
    detail: async () => { evidence.requests++; return raw; },
    transaction: async (_candidate, apply) => apply({
      source: async () => ({ revision: "old", raw: { ...raw, milesIn: 5 } }),
      replace: async () => { evidence.replacements++; },
      complete: async state => { evidence.completion = state; },
    }),
    defer: async (_c, reason) => { evidence.deferred = reason; },
    exception: async (_c, reason) => { evidence.exception = reason; },
  };
  return { deps, evidence };
}
test("corrected source and completion use the same transaction callback", async () => {
  const { deps, evidence } = fixture();
  const result = await reconcileTick(deps);
  assert.equal(result.corrected, 1);
  assert.equal(evidence.replacements, 1);
  assert.equal(evidence.completion, "corrected");
});
test("daytime, revoked scope, and denied shared capacity do not fetch", async () => {
  for (const mode of ["day", "scope", "capacity"]) {
    const { deps, evidence } = fixture();
    if (mode === "day") deps.now = () => new Date("2026-10-01T18:00:00Z");
    if (mode === "scope") deps.scope = async () => null;
    if (mode === "capacity") deps.acquireBackgroundSlot = async () => false;
    await reconcileTick(deps);
    assert.equal(evidence.requests, 0);
    assert.equal(evidence.replacements, 0);
  }
});
test("a concurrent source update prevents replacement", async () => {
  const { deps, evidence } = fixture();
  deps.transaction = async (_candidate, apply) => apply({
    source: async () => ({ revision: "new", raw }),
    replace: async () => { throw Error("must not overwrite"); },
    complete: async state => { evidence.completion = state; },
  });
  assert.equal((await reconcileTick(deps)).conflicts, 1);
  assert.equal(evidence.completion, "conflict");
});
test("429 is deferred once without retry", async () => {
  const { deps, evidence } = fixture();
  deps.detail = async () => { evidence.requests++; throw { status: 429 }; };
  await reconcileTick(deps);
  assert.equal(evidence.requests, 1);
  assert.equal(evidence.deferred, "provider_throttled");
  assert.equal(evidence.replacements, 0);
});
test("revocation during fetch prevents writes", async () => {
  const { deps, evidence } = fixture();
  deps.detail = async () => { deps.scope = async () => null; return raw; };
  await reconcileTick(deps);
  assert.equal(evidence.replacements, 0);
  assert.equal(evidence.deferred, "scope_window_or_deadline");
});
test("missing children are an exception, not authority to delete", async () => {
  const { deps, evidence } = fixture();
  deps.detail = async () => ({ ...raw, jobs: undefined });
  await reconcileTick(deps);
  assert.equal(evidence.replacements, 0);
  assert.equal(evidence.exception, "incomplete_or_ambiguous_detail");
});
