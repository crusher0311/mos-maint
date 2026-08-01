/**
 * Regression smoke test (task #1000 review fix): AutoFlow webhook payloads
 * with NO stable identity (no externalId / email / phone) must each create
 * a DISTINCT customer record — never a selector-based upsert. A previous
 * regression keyed the no-identity path on a `{ shopId }` selector, which
 * collapsed every anonymous webhook customer in a shop onto one row and
 * overwrote unrelated customer data.
 *
 * Run: `npx tsx tests/autoflow-no-identity-insert.smoke.ts`
 *
 * The test stubs the customers repository module (no DB access — dev Mongo
 * is prod) and drives `upsertCustomerFromAutoflow` with two different
 * no-identity payloads for the same shop, asserting:
 *   1. the path calls `insertCustomer` (unconditional insert), never
 *      `upsertCustomerBySelector` / `findCustomerIdBySelectors`;
 *   2. two payloads produce two inserts with two distinct customer ids;
 *   3. identity-bearing payloads still go through the selector path.
 */
import Module from "node:module";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  \u2713 ${name}`);
  else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

// ---- stub the repo modules before importing the model under test --------
const calls = {
  insert: [] as any[],
  upsertBySelector: [] as any[],
  findBySelectors: [] as any[],
};
let nextId = 1;

const customersRepoStub = {
  insertCustomer: async (doc: any) => {
    calls.insert.push(doc);
    return `pgid-${nextId++}`;
  },
  upsertCustomerBySelector: async (selector: any) => {
    calls.upsertBySelector.push(selector);
  },
  findCustomerIdBySelectors: async (selectors: any[]) => {
    calls.findBySelectors.push(selectors);
    return { _id: `found-${nextId++}` };
  },
  updateCustomerByHandle: async () => {},
  findOpenCustomersForDashboard: async () => [],
};
const vehiclesRepoStub = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      return async () => null;
    },
  },
);
const mongoStub = {
  getDb: async () => ({
    collection: () => ({
      findOne: async () => null,
      updateOne: async () => ({}),
      insertOne: async () => ({ insertedId: "mongo-id" }),
    }),
  }),
};

const origResolve = (Module as any)._resolveFilename;
const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request.includes("data/repositories/customers")) return customersRepoStub;
  if (request.includes("data/repositories/vehicles")) return vehiclesRepoStub;
  if (request === "@/lib/mongo" || request.endsWith("/lib/mongo")) return mongoStub;
  return origLoad.call(this, request, parent, isMain);
};

async function main() {
  const { upsertCustomerFromAutoflow } = await import("../lib/models/customers");

  // Two no-identity payloads (name only) for the same shop.
  const p1 = { customer: { firstname: "Anon", lastname: "One" }, ticket: { id: "T1", status: "open" } };
  const p2 = { customer: { firstname: "Anon", lastname: "Two" }, ticket: { id: "T2", status: "open" } };

  const r1 = await upsertCustomerFromAutoflow(101, p1 as any);
  const r2 = await upsertCustomerFromAutoflow(101, p2 as any);

  ok("no-identity payloads use unconditional insert", calls.insert.length === 2, `insert calls=${calls.insert.length}`);
  ok("no selector-based upsert on the no-identity path", calls.upsertBySelector.length === 0, JSON.stringify(calls.upsertBySelector));
  ok("no selector lookup on the no-identity path", calls.findBySelectors.length === 0);
  ok("two payloads produce two distinct customer ids",
    !!r1.customerId && !!r2.customerId && String(r1.customerId) !== String(r2.customerId),
    `ids=${String(r1.customerId)},${String(r2.customerId)}`);
  ok("inserted docs are shop-scoped", calls.insert.every((d) => d.shopId === 101));

  // Identity-bearing payload still routes through the selector path.
  calls.insert.length = 0;
  const p3 = { customer: { firstname: "Known", email: "known@example.com" }, ticket: { id: "T3" } };
  await upsertCustomerFromAutoflow(101, p3 as any);
  ok("identity payload uses selector lookup, not blind insert",
    calls.findBySelectors.length === 1 && calls.insert.length === 0);
}

main()
  .then(() => {
    (Module as any)._load = origLoad;
    (Module as any)._resolveFilename = origResolve;
    if (failed) {
      console.error(`\n${failed} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nAll checks passed.");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
