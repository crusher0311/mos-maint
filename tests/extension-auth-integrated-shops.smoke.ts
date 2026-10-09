/**
 * Manual extension login against realistic, projected shop settings. No Mongo or
 * session store is contacted. Run: npx tsx tests/extension-auth-integrated-shops.smoke.ts
 */
import bcrypt from "bcryptjs";
import type { Db } from "mongodb";
import { NextRequest } from "next/server";
import { __deps, POST } from "../app/api/extension/auth/route-handler";

type Doc = Record<string, any>;
const password = "correct-horse";
const email = "integrations@example.com";
const expiresAt = new Date("2030-01-01T00:00:00.000Z");

function projected(doc: Doc, fields: Doc): Doc {
  const result: Doc = {};
  for (const [path, enabled] of Object.entries(fields)) {
    if (enabled !== 1) throw new Error(`Unexpected projection entry ${path}`);
    const keys = path.split(".");
    let source: any = doc;
    for (const key of keys) source = source?.[key];
    if (source === undefined) continue;
    let dest = result;
    for (const key of keys.slice(0, -1)) dest = dest[key] ??= {};
    dest[keys[keys.length - 1]] = source;
  }
  return result;
}

function fakeDb(users: Doc[], shops: Doc[], queried: { count: number }): Db {
  return {
    collection(name: string) {
      if (name === "users") return {
        find(filter: Doc) {
          if (Object.keys(filter).join() !== "email" || filter.email !== email) {
            throw new Error(`Unexpected user query: ${JSON.stringify(filter)}`);
          }
          return { toArray: async () => users.filter((u) => u.email === filter.email) };
        },
      };
      if (name === "shops") return {
        find(filter: Doc) {
          const ids = filter?.shopId?.$in;
          if (!Array.isArray(ids) || Object.keys(filter).join() !== "shopId" ||
              !ids.every((id) => typeof id === "number" || typeof id === "string")) {
            throw new Error(`Shop lookup must filter by shopId $in: ${JSON.stringify(filter)}`);
          }
          queried.count++;
          return {
            project(fields: Doc) {
              if (!fields || fields.shopId !== 1 || fields.integrationProvider !== 1) {
                throw new Error(`Shop lookup must project configuration: ${JSON.stringify(fields)}`);
              }
              return {
                toArray: async () => shops
                  .filter((shop) => ids.some((id) => id === shop.shopId))
                  .map((shop) => projected(shop, fields)),
              };
            },
          };
        },
      };
      throw new Error(`Unexpected collection: ${name}`);
    },
  } as unknown as Db;
}

type Expected = {
  status: number;
  shopId?: number;
  provider?: string;
  smsShopId?: string | null;
  shopSmsShopId?: string | number | null;
  integrations?: string[];
  autoflowSubdomain?: string | null;
  autoflowShopNumbers?: string[];
  shopIds?: number[];
  error?: RegExp;
};

async function run() {
  const originals = {
    getDb: __deps.getDb,
    issue: __deps.issueExtensionSession,
    lookup: __deps.lookupExtensionSession,
    revoke: __deps.revokeExtensionSession,
  };
  let failures = 0;
  let cases = 0;
  const hash = await bcrypt.hash(password, 4);
  const check = (label: string, condition: boolean, detail: unknown) => {
    if (!condition) {
      failures++;
      console.error(`FAIL ${label}: ${JSON.stringify(detail)}`);
    }
  };

  async function login(
    label: string,
    users: Doc[],
    shops: Doc[],
    request: Doc,
    expected: Expected,
  ) {
    cases++;
    const queried = { count: 0 };
    const issued: Doc[] = [];
    __deps.getDb = async () => fakeDb(users, shops, queried);
    __deps.issueExtensionSession = (async (input: Doc) => {
      issued.push(input);
      return {
        token: "exts_integrated_shops_fixture",
        principal: {
          sessionId: "fixture-session",
          userId: input.userId,
          assurance: input.assurance,
          shopId: input.shopId,
          provider: input.provider,
          capabilities: ["read", "write"],
          expiresAt,
        },
      };
    }) as typeof __deps.issueExtensionSession;
    const response = await POST(new NextRequest("http://localhost/api/extension/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, ...request }),
    }));
    const body = await response.json();
    const detail = { status: response.status, body, issued, queried };
    check(`${label}: status ${expected.status}`, response.status === expected.status, detail);
    check(`${label}: shop query count`, queried.count === (expected.status === 401 ? 0 : 1), detail);
    check(`${label}: session issuance count`, issued.length === (expected.status === 200 ? 1 : 0), detail);
    if (expected.status === 200) {
      check(`${label}: verified scoped issuance`,
        issued[0]?.shopId === expected.shopId &&
        issued[0]?.provider === expected.provider &&
        issued[0]?.assurance === "verified" &&
        issued[0]?.userId === "user-1", detail);
      check(`${label}: scoped response`,
        body.token === "exts_integrated_shops_fixture" &&
        body.session?.shopId === expected.shopId &&
        body.session?.provider === expected.provider &&
        body.session?.assurance === "verified" &&
        body.user?.shopId === expected.shopId, detail);
      const selected = body.shops?.find((shop: Doc) => Number(shop.shopId) === expected.shopId);
      if ("smsShopId" in expected) check(`${label}: session smsShopId`,
        body.session?.smsShopId === expected.smsShopId, detail);
      if ("shopSmsShopId" in expected) check(`${label}: shop smsShopId`,
        selected?.smsShopId === expected.shopSmsShopId, detail);
      if (expected.integrations) check(`${label}: integrations`,
        expected.integrations.every((name) => selected?.integrations?.includes(name)), detail);
      if ("autoflowSubdomain" in expected) check(`${label}: AutoFlow subdomain`,
        selected?.autoflowSubdomain === expected.autoflowSubdomain, detail);
      if (expected.autoflowShopNumbers) check(`${label}: AutoFlow shop numbers`,
        JSON.stringify(selected?.autoflowShopNumbers) === JSON.stringify(expected.autoflowShopNumbers), detail);
      if (expected.shopIds) check(`${label}: assigned shops only`,
        JSON.stringify(body.user?.shopIds) === JSON.stringify(expected.shopIds) &&
        body.shops?.every((shop: Doc) => expected.shopIds!.includes(Number(shop.shopId))), detail);
    } else {
      check(`${label}: error`, typeof body.error === "string" &&
        (!expected.error || expected.error.test(body.error)), detail);
      check(`${label}: no session token`, !body.token, detail);
    }
  }

  const user = (fields: Doc = {}): Doc => ({
    _id: "user-1", email, passwordHash: hash, shopId: 10, ...fields,
  });
  const auto = { shopId: 10, name: "Legacy AutoFlow", autoflowDomain: "legacy.autotext.me",
    autoflowApiKey: "fixture-key", autoflowApiPassword: "fixture-password" };
  const a = { shopId: 10, provider: "autoflow", smsShopId: "legacy", shopSmsShopId: "legacy.autotext.me", integrations: ["autoflow"], autoflowSubdomain: "legacy" };
  const sw = { shopId: 10, provider: "shopware", integrations: ["shopware"] };

  try {
    await login("top-level domain without tab", [user()], [auto], {}, { status: 200, ...a });
    await login("top-level domain with stale tab", [user()], [auto],
      { provider: "autoflow", smsShopId: "old-tab" }, { status: 200, ...a });
    await login("top-level domain with matching tab", [user()], [auto],
      { provider: "autoflow", smsShopId: "legacy.autotext.me" }, { status: 200, ...a });
    for (const [label, settings, sms] of [
      ["nested domain", { domain: "domain.autotext.me" }, "domain"],
      ["nested subdomain", { subdomain: "subdomain" }, "subdomain"],
      ["nested shopId", { shopId: "af-123" }, "af-123"],
    ] as const) {
      await login(label, [user()], [{ shopId: 10, autoflow: settings }], {},
        { status: 200, shopId: 10, provider: "autoflow", smsShopId: sms, integrations: ["autoflow"] });
    }
    await login("shopNumbers-only AutoFlow", [user()],
      [{ shopId: 10, autoflow: { shopNumbers: [" 123 ", "456"] } }],
      { provider: "autoflow", smsShopId: "456" },
      { status: 200, shopId: 10, provider: "autoflow", smsShopId: "456",
        integrations: ["autoflow"], autoflowShopNumbers: ["123", "456"] });
    await login("Shop-Ware tenantId and swShopId", [user()],
      [{ shopId: 10, shopware: { tenantId: 101, swShopId: 42 } }], {},
      { status: 200, ...sw, smsShopId: "101", shopSmsShopId: 101 });
    await login("Shop-Ware tenantSubdomain only", [user()],
      [{ shopId: 10, shopware: { tenantSubdomain: "tenant-sub" } }], {},
      { status: 200, ...sw, smsShopId: "tenant-sub", shopSmsShopId: "tenant-sub" });
    for (const alias of ["shop-ware", "shop_ware", " Shop-Ware "]) {
      await login(`Shop-Ware alias ${JSON.stringify(alias)}`, [user()],
        [{ shopId: 10, integrationProvider: alias, shopware: { tenantId: 101, swShopId: 42 } }],
        { provider: alias, smsShopId: "101" },
        { status: 200, ...sw, smsShopId: "101", shopSmsShopId: 101 });
    }
    await login("explicit supported primary on mixed providers", [user()],
      [{ shopId: 10, integrationProvider: "protractor", protractor: { connectionId: "pt-10" },
        tekmetric: { shopId: 200 }, shopware: { tenantId: "tenant-1" }, autoflowDomain: "dual.autotext.me" }],
      {}, { status: 200, shopId: 10, provider: "protractor", smsShopId: "pt-10",
        integrations: ["protractor", "tekmetric", "shopware", "autoflow"], autoflowSubdomain: "dual" });
    await login("mixed shop matched AutoFlow tab retains context scoping", [user()],
      [{ shopId: 10, integrationProvider: "protractor", protractor: { connectionId: "pt-10" },
        autoflowDomain: "dual.autotext.me" }],
      { provider: "autoflow", smsShopId: "dual" },
      { status: 200, shopId: 10, provider: "autoflow", smsShopId: "dual",
        integrations: ["protractor", "autoflow"] });
    await login("stale explicit tekmetric must not remap", [user()],
      [{ shopId: 10, integrationProvider: "tekmetric", autoflowDomain: "legacy.autotext.me" }],
      {}, { status: 403, error: /configured shop/i });
    await login("Shop-Ware connected but stale explicit primary must not remap", [user()],
      [{ shopId: 10, integrationProvider: "tekmetric", smsProvider: "shopware",
        shopware: { tenantId: 101, swShopId: 42 } }],
      {}, { status: 403, error: /configured shop/i });
    await login("Shop-Ware stale tab is advisory", [user()],
      [{ shopId: 10, smsProvider: "shopware", shopware: { tenantId: 101, swShopId: 42 } }],
      { provider: "shopware", smsShopId: "unassigned" },
      { status: 200, ...sw, smsShopId: "101" });
    await login("empty AutoFlow learned numbers are unconfigured", [user()],
      [{ shopId: 10, autoflow: { shopNumbers: [] } }], {},
      { status: 403, error: /configured shop/i });
    await login("unknown explicit provider must not remap", [user()],
      [{ shopId: 10, integrationProvider: "unrecognized", shopware: { tenantId: "tenant-1" } }],
      {}, { status: 403, error: /configured shop/i });
    await login("numeric assignment to string shop", [user()],
      [{ shopId: "10", autoflowDomain: "legacy.autotext.me" }], {}, { status: 200, ...a });
    await login("string assignment to numeric shop", [user({ shopId: "10" })],
      [auto], {}, { status: 200, ...a });
    await login("shopIds-only account", [user({ shopId: undefined, shopIds: ["10", 11] })],
      [auto, { shopId: 11, tekmetric: { shopId: 201 } }, { shopId: 99, tekmetric: { shopId: 999 } }],
      {}, { status: 200, ...a, shopIds: [10, 11] });
    await login("duplicate email assignments", [user(), user({ _id: "user-2", shopId: 11, passwordHash: "invalid" })],
      [auto, { shopId: 11, tekmetric: { shopId: 201 } }, { shopId: 99, tekmetric: { shopId: 999 } }],
      { shopId: 11 }, { status: 200, shopId: 11, provider: "tekmetric", smsShopId: "201", shopIds: [10, 11] });
    await login("assigned shop absent from shops collection", [user()], [], {},
      { status: 403, error: /configured shop/i });
    await login("assigned shop unconfigured", [user()], [{ shopId: 10, name: "Unconfigured" }], {},
      { status: 403, error: /configured shop/i });
    await login("explicit unassigned request", [user()], [auto, { shopId: 99, tekmetric: { shopId: 999 } }],
      { shopId: 99 }, { status: 403, error: /not assigned/i });
    await login("invalid credentials", [user()], [auto], { password: "incorrect" },
      { status: 401, error: /invalid email or password/i });
  } finally {
    __deps.getDb = originals.getDb;
    __deps.issueExtensionSession = originals.issue;
    __deps.lookupExtensionSession = originals.lookup;
    __deps.revokeExtensionSession = originals.revoke;
  }
  console.log(`${cases} integrated-shop auth scenarios; ${failures} failed assertions`);
  if (failures) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});