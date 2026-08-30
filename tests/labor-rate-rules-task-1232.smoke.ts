import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LaborRateRuleValidationError,
  canManageEnterpriseLaborRates,
  laborRateRuleSetsEqual,
  normalizeLaborRateRuleSet,
  readLaborRateRuleSet,
  replaceLaborRateRuleSet,
  replaceLaborRateRuleSetForShops,
  validateEnterpriseLaborRateScope,
} from "../lib/labor-rate-rules";
import {
  __laborRateRuleDeps,
  findShopLaborRateRulesById,
  listShopsByShopIds,
  listShopLaborRateRulesByIds,
  replaceLaborRateRulesForShopIds,
} from "../lib/data/repositories/shops";

const oldRule = {
  id: "old",
  name: "Old",
  rate: 90,
  priority: 0,
  conditions: [],
  matchMode: "all",
  overrideCategoryRates: false,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};
const newRule = {
  ...oldRule,
  id: "new",
  name: "New",
  rate: 140,
  color: "#3B82F6",
  applyToAllLabor: true,
};

function matches(doc: any, query: any) {
  if (Array.isArray(query.$or)) {
    return query.$or.some((branch: any) => matches(doc, branch));
  }
  const expected = query.shopId;
  return expected?.$in ? expected.$in.includes(doc.shopId) : doc.shopId === expected;
}

function fakeCollection(seed: any[]) {
  const docs = structuredClone(seed);
  return {
    docs,
    async findOne(query: any) {
      return docs.find((doc) => matches(doc, query)) || null;
    },
    find(query: any) {
      return { toArray: async () => docs.filter((doc) => matches(doc, query)) };
    },
    async updateOne(query: any, update: any) {
      const doc = docs.find((item) => matches(item, query));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(query: any, update: any) {
      const matched = docs.filter((item) => matches(item, query));
      matched.forEach((doc) => Object.assign(doc, update.$set));
      return { matchedCount: matched.length, modifiedCount: matched.length };
    },
  };
}

async function run() {
  assert.equal(canManageEnterpriseLaborRates({ role: "owner" }), true);
  assert.equal(canManageEnterpriseLaborRates({ role: "admin" }), true);
  assert.equal(canManageEnterpriseLaborRates({ role: "manager" }), false);
  assert.equal(canManageEnterpriseLaborRates({ role: "user" }), false);
  assert.equal(canManageEnterpriseLaborRates({ role: "platform_admin" }), true);

  assert.deepEqual(
    validateEnterpriseLaborRateScope({
      currentShopId: 10,
      enterpriseShopIds: [10, 11],
      sourceShopId: 11,
      destinationShopIds: [10],
    }).enterpriseShopIds,
    [10, 11],
  );
  assert.throws(
    () =>
      validateEnterpriseLaborRateScope({
        currentShopId: 10,
        enterpriseShopIds: [10, 11],
        sourceShopId: 99,
      }),
    LaborRateRuleValidationError,
  );
  assert.throws(
    () =>
      validateEnterpriseLaborRateScope({
        currentShopId: 99,
        enterpriseShopIds: [10, 11],
      }),
    /Current shop/,
  );
  assert.throws(
    () =>
      validateEnterpriseLaborRateScope({
        currentShopId: 10,
        enterpriseShopIds: [10, 11],
        destinationShopIds: [12],
      }),
    /Destination shop/,
  );

  const collection = fakeCollection([
    { shopId: 10, laborRateRules: [oldRule, newRule] },
    { shopId: 11, laborRateRules: [oldRule] },
    { shopId: 12, laborRateRules: [oldRule] },
    { shopId: 99, laborRateRules: [oldRule] },
  ]);
  const normalizedNew = normalizeLaborRateRuleSet([newRule]);
  assert.equal(normalizedNew[0].color, "#3B82F6");
  assert.equal(normalizedNew[0].applyToAllLabor, true);
  assert.equal(
    laborRateRuleSetsEqual(
      normalizedNew,
      normalizeLaborRateRuleSet([
        {
          ...newRule,
          createdAt: new Date("2025-01-01"),
          updatedAt: new Date("2025-01-02"),
        },
      ]),
    ),
    true,
    "audit timestamps must not make otherwise identical location rules inconsistent",
  );
  await replaceLaborRateRuleSet(collection as any, 10, normalizedNew);
  assert.deepEqual((await readLaborRateRuleSet(collection as any, 10)).map((r) => r.id), ["new"]);

  // Empty is an intentional complete-set clear, not "no update".
  const empty = normalizeLaborRateRuleSet([]);
  await replaceLaborRateRuleSet(collection as any, 11, empty);
  assert.deepEqual(await readLaborRateRuleSet(collection as any, 11), []);
  const copiedEmptySet = await readLaborRateRuleSet(collection as any, 11);
  await replaceLaborRateRuleSet(collection as any, 10, copiedEmptySet);
  assert.deepEqual(await readLaborRateRuleSet(collection as any, 10), []);

  // Bulk replacement updates every selected location, and no location outside it.
  const result = await replaceLaborRateRuleSetForShops(
    collection as any,
    [10, 11, 12],
    normalizedNew,
  );
  assert.equal(result.matchedCount, 3);
  for (const id of [10, 11, 12]) {
    assert.deepEqual((await readLaborRateRuleSet(collection as any, id)).map((r) => r.id), ["new"]);
  }
  assert.deepEqual((await readLaborRateRuleSet(collection as any, 99)).map((r) => r.id), ["old"]);

  await replaceLaborRateRuleSetForShops(collection as any, [10, 11, 12], []);
  for (const id of [10, 11, 12]) {
    assert.deepEqual(await readLaborRateRuleSet(collection as any, id), []);
  }

  // Legacy shop documents may store shopId as a string. Shared complete-set
  // operations must preserve the project's established dual-ID semantics.
  const mixedIds = fakeCollection([
    { shopId: 20, laborRateRules: [oldRule] },
    { shopId: "21", laborRateRules: [oldRule] },
  ]);
  const mixedResult = await replaceLaborRateRuleSetForShops(
    mixedIds as any,
    [20, 21],
    normalizedNew,
  );
  assert.equal(mixedResult.matchedCount, 2);
  assert.deepEqual((await readLaborRateRuleSet(mixedIds as any, 21)).map((r) => r.id), ["new"]);

  // Canonical mode must keep the location page, enterprise APIs, copy actions,
  // and extension reader/writer on the same Postgres-backed representation.
  const originalRepositoryDeps = { ...__laborRateRuleDeps };
  const canonicalWrites: Array<{ ids: number[]; rules: unknown[] }> = [];
  try {
    __laborRateRuleDeps.isIdentityPgCanonical = () => true;
    __laborRateRuleDeps.findPgShop = async (shopId: number | string) => ({
      shopId: Number(shopId),
      laborRateRules: normalizedNew,
    });
    __laborRateRuleDeps.listPgShops = async (ids: number[]) =>
      ids.map((shopId) => ({ shopId, laborRateRules: normalizedNew }));
    __laborRateRuleDeps.replacePgLaborRateRules = async (ids, rules) => {
      canonicalWrites.push({ ids, rules });
      return { matchedCount: ids.length, modifiedCount: ids.length };
    };
    __laborRateRuleDeps.getCollection = async () => {
      throw new Error("Mongo must not be touched in canonical mode");
    };

    assert.deepEqual(
      (await findShopLaborRateRulesById(20))?.laborRateRules,
      normalizedNew,
    );
    assert.equal((await listShopLaborRateRulesByIds([20, 21])).length, 2);
    const canonicalResult = await replaceLaborRateRulesForShopIds(
      [20, 21],
      normalizedNew,
    );
    assert.equal(canonicalResult.matchedCount, 2);
    assert.deepEqual(canonicalWrites, [{ ids: [20, 21], rules: normalizedNew }]);
  } finally {
    Object.assign(__laborRateRuleDeps, originalRepositoryDeps);
  }

  // The enterprise location picker must include legacy shops whose Mongo
  // shopId was stored as a string.
  let locationQuery: any;
  try {
    __laborRateRuleDeps.isIdentityPgCanonical = () => false;
    __laborRateRuleDeps.getCollection = async () => ({
      find(query: any) {
        locationQuery = query;
        return {
          project() { return this; },
          async toArray() { return []; },
        };
      },
    } as any);
    await listShopsByShopIds([20, 21], { shopId: 1 });
    assert.deepEqual(locationQuery.shopId.$in, [20, 21, "20", "21"]);
  } finally {
    Object.assign(__laborRateRuleDeps, originalRepositoryDeps);
  }

  // Labor-only copy handlers may import Mongo for legacy setting types, but
  // must acquire it only in the non-labor fallthrough branch.
  const copyRouteSource = readFileSync(
    new URL("../app/api/enterprise/copy-settings/route.ts", import.meta.url),
    "utf8",
  );
  assert.equal((copyRouteSource.match(/await getDb\(\)/g) || []).length, 1);
  assert.ok(
    copyRouteSource.indexOf("await getDb()") >
      copyRouteSource.indexOf("if (includesLaborRates && types.length === 1)"),
  );

  console.log("labor-rate task 1232 smoke checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});