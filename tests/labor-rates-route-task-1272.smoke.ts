/**
 * Task #1272 smoke coverage for the extension labor-rates resolver.
 *
 * The labor-rates route must resolve the provider's SMS identity only inside
 * the authenticated shop scope. It must not treat a MOS shopId as a provider
 * identity, guess through provider collisions, or persist a newly discovered
 * mapping while loading rules.
 */

import assert from "node:assert/strict";
import {
  __laborRateRouteDeps,
  resolveLaborRateShop,
} from "../lib/extension-labor-rate-shop";

function getPath(doc: any, path: string): unknown {
  return path.split(".").reduce((value, segment) => value?.[segment], doc);
}

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && "$in" in expected) {
    const values = (expected as { $in: unknown[] }).$in;
    return Array.isArray(actual)
      ? actual.some((item) => values.includes(item))
      : values.includes(actual);
  }
  return actual === expected;
}

function matches(doc: any, query: any): boolean {
  if (Array.isArray(query.$or) && !query.$or.some((branch: any) => matches(doc, branch))) {
    return false;
  }
  return Object.entries(query).every(([path, expected]) => {
    if (path.startsWith("$")) return true;
    return matchesValue(getPath(doc, path), expected);
  });
}

function auth(
  shopId: unknown,
  shopIds: unknown[],
  provider?: string,
  legacy = false,
) {
  return {
    user: {
      role: "user",
      shopId,
      shopIds,
    },
    principal: {
      shopId: typeof shopId === "number" ? shopId : Number(shopId),
      provider,
      assurance: "verified",
      capabilities: ["read", "write"],
      expiresAt: new Date(Date.now() + 60_000),
      ...(legacy ? { isLegacy: true } : {}),
    },
  } as any;
}

async function run() {
  const original = __laborRateRouteDeps.listShopsByQuery;
  const docs = [
    {
      _id: "numeric-tek",
      // QA fixture: the provider SMS id is deliberately different from the
      // internal MOS id (SMS 14245 -> MOS 63).
      shopId: 63,
      tekmetric: { shopId: 14245 },
      integrationProvider: "tekmetric",
    },
    {
      _id: "string-tek",
      shopId: "702",
      tekmetricShopId: "9002",
      integrationProvider: "tekmetric",
    },
    {
      _id: "colliding-pro",
      shopId: 703,
      protractor: { connectionId: "14245" },
      integrationProvider: "protractor",
    },
  ];

  __laborRateRouteDeps.listShopsByQuery = async (query: any) =>
    docs.filter((doc) => matches(doc, query)) as any;

  try {
    // A provider SMS id is not a MOS shop id. Both numeric and string
    // Tekmetric storage shapes resolve to the distinct internal shop.
    const numeric = await resolveLaborRateShop({
      auth: auth(63, [63], "tekmetric"),
      smsShopId: "14245",
    });
    assert.equal(numeric.ok, true);
    if (numeric.ok) assert.equal(numeric.mosShopId, 63);

    const string = await resolveLaborRateShop({
      auth: auth("702", ["702"], "tekmetric"),
      smsShopId: "9002",
      requestedProvider: "tekmetric",
    });
    assert.equal(string.ok, true);
    if (string.ok) assert.equal(string.mosShopId, 702);

    // Membership remains authoritative, including an explicitly empty
    // membership. The empty case must fail before any unrestricted lookup.
    const unauthorized = await resolveLaborRateShop({
      auth: auth(999, [999], "tekmetric"),
      smsShopId: "14245",
    });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.status, 404);

    let lookupCalls = 0;
    __laborRateRouteDeps.listShopsByQuery = async () => {
      lookupCalls += 1;
      return docs as any;
    };
    const emptyMembership = await resolveLaborRateShop({
      auth: auth(undefined, [], "tekmetric"),
      smsShopId: "14245",
    });
    assert.equal(emptyMembership.ok, false);
    assert.equal(emptyMembership.status, 403);
    assert.equal(lookupCalls, 0);

    __laborRateRouteDeps.listShopsByQuery = async (query: any) =>
      docs.filter((doc) => matches(doc, query)) as any;

    // An omitted provider is not itself a root-cause claim: when the
    // authenticated membership leaves one persisted identity candidate, the
    // resolver can safely infer the provider from that identity shape.
    const providerOmitted = await resolveLaborRateShop({
      auth: auth(63, [63], undefined, true),
      smsShopId: "14245",
    });
    assert.equal(providerOmitted.ok, true);
    if (providerOmitted.ok) assert.equal(providerOmitted.mosShopId, 63);

    // Without a provider hint, the colliding persisted identities are
    // ambiguous and fail closed. An explicit provider selects only its own
    // identity family; the other provider cannot shadow it.
    __laborRateRouteDeps.listShopsByQuery = async (query: any) =>
      docs.filter((doc) => matches(doc, query)) as any;
    const collision = await resolveLaborRateShop({
      auth: auth(63, [63, 703], undefined, true),
      smsShopId: "14245",
    });
    assert.equal(collision.ok, false);
    assert.equal(collision.status, 404);

    const providerScoped = await resolveLaborRateShop({
      auth: auth(63, [63, 703], "tekmetric"),
      smsShopId: "14245",
    });
    assert.equal(providerScoped.ok, true);
    if (providerScoped.ok) assert.equal(providerScoped.mosShopId, 63);

    const unsupported = await resolveLaborRateShop({
      auth: auth(63, [63]),
      smsShopId: "14245",
      requestedProvider: "not-a-provider",
    });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.status, 400);

    // A malformed integration identity and a direct MOS-id-only document are
    // never accepted as a provider mapping.
    __laborRateRouteDeps.listShopsByQuery = async () =>
      [{
        _id: "malformed",
        shopId: "not-a-number",
        tekmetric: { shopId: "14245" },
        integrationProvider: "tekmetric",
      }] as any;
    const malformed = await resolveLaborRateShop({
      auth: auth(63, [63], "tekmetric"),
      smsShopId: "14245",
    });
    assert.equal(malformed.ok, false);

    __laborRateRouteDeps.listShopsByQuery = async () =>
      [{
        _id: "mos-only",
        shopId: "14245",
        integrationProvider: "tekmetric",
      }] as any;
    const mosOnly = await resolveLaborRateShop({
      auth: auth(14245, [14245], "tekmetric"),
      smsShopId: "14245",
    });
    assert.equal(mosOnly.ok, false);

    console.log("labor-rates route task 1272 smoke checks passed");
  } finally {
    __laborRateRouteDeps.listShopsByQuery = original;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
