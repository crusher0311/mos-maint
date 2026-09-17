import assert from "node:assert/strict";
import { test } from "node:test";
import { CUSTOMER_SOURCE_INDEX, planCustomerSourceIndex } from "../scripts/lib/customer-source-index";

test("index supports the actual SourceId field names, within the same array", () => {
  assert.deepEqual(CUSTOMER_SOURCE_INDEX.key, {
    shopId: 1, "provenance.sourceIds.system": 1, "provenance.sourceIds.idValue": 1,
  });
});
test("shop-only and obsolete provenance indexes do not satisfy the lookup", () => {
  assert.equal(planCustomerSourceIndex([
    { name: "shopId", key: { shopId: 1 } },
    { name: "source_lookup", key: { "provenance.sourceSystem": 1, "provenance.sourceIds.id": 1 } },
  ]).action, "create");
});
test("reuse a supporting production index under a custom name", () => {
  assert.deepEqual(planCustomerSourceIndex([{ name: "operator_created", key: CUSTOMER_SOURCE_INDEX.key }]),
    { action: "exists", name: "operator_created" });
});
test("reuse a longer supporting equality prefix", () => {
  assert.equal(planCustomerSourceIndex([{
    name: "longer", key: { ...CUSTOMER_SOURCE_INDEX.key, "provenance.sourceIds.idType": 1 },
  }]).action, "exists");
});
test("hidden, partial, sparse and non-simple indexes are not silently accepted", () => {
  for (const options of [{ hidden: true }, { sparse: true },
    { partialFilterExpression: { shopId: 1 } }, { collation: { locale: "en" } }]) {
    assert.equal(planCustomerSourceIndex([{
      name: "not_universal", key: CUSTOMER_SOURCE_INDEX.key, ...options,
    }]).action, "create");
  }
});
test("never drop or replace a conflicting index", () => {
  assert.throws(() => planCustomerSourceIndex([{
    name: CUSTOMER_SOURCE_INDEX.name, key: { shopId: 1 },
  }]), /refusing to replace/);
});