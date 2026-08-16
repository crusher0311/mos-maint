/**
 * Cross-tenant authorization regression tests (task #1129).
 *
 * Verifies that routes which gained auth guards also enforce shop-level
 * authorization — i.e. an authenticated user from shop A cannot read or
 * mutate shop B's data by supplying foreign IDs or shopId values.
 *
 * Run:
 *   NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
 *     npx tsx tests/cross-tenant-route-auth.smoke.ts
 *
 * All real DB / auth dependencies are swapped via each route's `__deps`
 * test seam, so nothing touches a real database.
 */

import { ObjectId } from "mongodb";
import { NextRequest } from "next/server";

import {
  GET as customerGET,
  __deps as customerDeps,
} from "../app/api/customers/[customerId]/route";
import {
  GET as inspectGET,
  __deps as inspectDeps,
} from "../app/api/customers/[customerId]/inspect/route";
import {
  POST as checkOrdersPOST,
  __deps as checkOrdersDeps,
} from "../app/api/vehicles/check-closed-orders/route";

import { makeFakeDb } from "./utils/fake-mongo";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const SHOP_A = 10;
const SHOP_B = 20;

// A valid Mongo ObjectId string we can use as a customerId
const CUSTOMER_B_ID = new ObjectId();

/**
 * Build a minimal DB stub for the customer routes.
 *
 * The fake-mongo helper uses strict === for ObjectId comparisons which always
 * fails across instances. Instead we return a hand-rolled stub that resolves
 * the customer doc directly (matching any _id query since the routes always
 * guard by shopId AFTER the lookup, not inside the query).
 */
function makeCustomerDb(customerDoc: any | null) {
  // A chainable cursor stub that always resolves to [] regardless of chain order.
  // Supports the patterns used by the customer routes:
  //   .find().sort().limit().toArray()
  //   .find().sort().limit().project().toArray()
  //   .find().project().sort().limit().toArray()
  function cursor(): any {
    const c: any = {
      sort: () => c,
      limit: () => c,
      project: () => c,
      next: async () => null,
      toArray: async () => [],
    };
    return c;
  }

  return {
    collection: (_name: string) => ({
      findOne: async () => customerDoc,
      find: () => cursor(),
    }),
  } as any;
}

function makeGetReq(url: string) {
  return new Request(`http://localhost${url}`);
}
function makePostReq(url: string, body: any) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Save originals for restore
const ORIG_CUSTOMER = { ...customerDeps };
const ORIG_INSPECT = { ...inspectDeps };
const ORIG_ORDERS = { ...checkOrdersDeps };

function restoreAll() {
  Object.assign(customerDeps, ORIG_CUSTOMER);
  Object.assign(inspectDeps, ORIG_INSPECT);
  Object.assign(checkOrdersDeps, ORIG_ORDERS);
}

// ---------------------------------------------------------------------------
// Tests: GET /api/customers/[customerId]
// ---------------------------------------------------------------------------

async function testCustomerRoute() {
  console.log("\n[1] GET /api/customers/[customerId]");

  const CUSTOMER_B = {
    _id: CUSTOMER_B_ID,
    shopId: SHOP_B,
    name: "Shop B Customer",
    email: "b@b.com",
    phone: "5550002",
  };
  const ctx = { params: { customerId: CUSTOMER_B_ID.toString() } };

  // 1a. No session → 401
  {
    customerDeps.getSession = (async () => null) as any;
    customerDeps.getDb = async () => makeCustomerDb(CUSTOMER_B);
    const res = await customerGET(makeGetReq("/api/customers/unused") as any, ctx);
    ok("no session → 401", res.status === 401);
  }

  // 1b. Session is shop A, customer belongs to shop B → 404 (no data leak)
  {
    customerDeps.getSession = async () => ({ shopId: SHOP_A, role: "admin" } as any);
    customerDeps.getDb = async () => makeCustomerDb(CUSTOMER_B);
    const res = await customerGET(makeGetReq("/api/customers/unused") as any, ctx);
    const body = await res.json();
    ok(
      "cross-tenant customer ID → 404 (not customer data)",
      res.status === 404,
      `got ${res.status}: ${JSON.stringify(body)}`,
    );
    ok(
      "response does not leak cross-tenant email",
      !JSON.stringify(body).includes("b@b.com"),
    );
  }

  // 1c. Session is shop B → 200, customer returned
  {
    customerDeps.getSession = async () => ({ shopId: SHOP_B, role: "admin" } as any);
    customerDeps.getDb = async () => makeCustomerDb(CUSTOMER_B);
    const res = await customerGET(makeGetReq("/api/customers/unused") as any, ctx);
    ok("same-shop customer ID → 200", res.status === 200, `got ${res.status}`);
  }

  // 1d. Platform admin can read any shop's customer → 200
  {
    customerDeps.getSession = async () =>
      ({ shopId: SHOP_A, isPlatformAdmin: true } as any);
    customerDeps.getDb = async () => makeCustomerDb(CUSTOMER_B);
    const res = await customerGET(makeGetReq("/api/customers/unused") as any, ctx);
    ok("platform-admin cross-shop → 200", res.status === 200, `got ${res.status}`);
  }

  restoreAll();
}

// ---------------------------------------------------------------------------
// Tests: GET /api/customers/[customerId]/inspect
// ---------------------------------------------------------------------------

async function testInspectRoute() {
  console.log("\n[2] GET /api/customers/[customerId]/inspect");

  const CUSTOMER_B = {
    _id: CUSTOMER_B_ID,
    shopId: SHOP_B,
    name: "Shop B Customer",
    email: "b@b.com",
    phone: "5550002",
  };
  const ctx = { params: { customerId: CUSTOMER_B_ID.toString() } };

  // 2a. No session → 401
  {
    inspectDeps.getSession = (async () => null) as any;
    inspectDeps.getDb = async () => makeCustomerDb(CUSTOMER_B);
    const res = await inspectGET(makeGetReq("/api/customers/unused/inspect"), ctx);
    ok("no session → 401", res.status === 401);
  }

  // 2b. Cross-tenant customer → 404
  {
    inspectDeps.getSession = async () => ({ shopId: SHOP_A, role: "admin" } as any);
    inspectDeps.getDb = async () => makeCustomerDb(CUSTOMER_B);
    const res = await inspectGET(makeGetReq("/api/customers/unused/inspect"), ctx);
    const body = await res.json();
    ok(
      "cross-tenant customer ID → 404",
      res.status === 404,
      `got ${res.status}: ${JSON.stringify(body)}`,
    );
    ok(
      "response does not leak cross-tenant name",
      !JSON.stringify(body).includes("Shop B Customer"),
    );
  }

  // 2c. Same shop → 200
  {
    inspectDeps.getSession = async () => ({ shopId: SHOP_B, role: "admin" } as any);
    inspectDeps.getDb = async () => makeCustomerDb(CUSTOMER_B);
    const res = await inspectGET(makeGetReq("/api/customers/unused/inspect"), ctx);
    ok("same-shop customer → 200", res.status === 200, `got ${res.status}`);
  }

  restoreAll();
}

// ---------------------------------------------------------------------------
// Tests: POST /api/vehicles/check-closed-orders (shopId from session, not body)
// ---------------------------------------------------------------------------

async function testCheckClosedOrdersRoute() {
  console.log("\n[3] POST /api/vehicles/check-closed-orders");

  // 3a. No session → 401
  {
    checkOrdersDeps.getSession = (async () => null) as any;
    checkOrdersDeps.getDb = (async () => { throw new Error("DB must not be reached"); }) as any;
    const res = await checkOrdersPOST(
      makePostReq("/api/vehicles/check-closed-orders", { shopId: SHOP_B }),
    );
    ok("no session → 401", res.status === 401);
  }

  // 3b. Authenticated as shop A but body has shopId=shop B → the route uses
  //     SHOP_A (from session) not SHOP_B (from body). Verified by recording
  //     which shopId was used in the shops collection query.
  {
    checkOrdersDeps.getSession = async () => ({ shopId: SHOP_A } as any);

    // Track which shopId the route queries in the shops collection
    let queriedShopId: number | undefined;
    const emptyFind = () => ({
      limit: () => ({ toArray: async () => [] }),
    });
    checkOrdersDeps.getDb = async () => ({
      collection: (name: string) => ({
        findOne: async (filter: any) => {
          if (name === "shops") {
            // filter.$or is [{shopId: String(n)}, {shopId: Number(n)}]
            const numEntry = filter?.$or?.[1];
            if (numEntry?.shopId != null) queriedShopId = Number(numEntry.shopId);
            // Return a shop so the route proceeds to the vehicles query
            return { shopId: SHOP_A, name: "Shop A" };
          }
          return null;
        },
        find: () => emptyFind(),
        updateOne: async () => ({ modifiedCount: 0 }),
      }),
    } as any);

    await checkOrdersPOST(
      makePostReq("/api/vehicles/check-closed-orders", { shopId: SHOP_B }),
    );

    ok(
      "body shopId ignored — session shopId used for DB query",
      queriedShopId === SHOP_A,
      `DB queried for shop ${queriedShopId}, expected ${SHOP_A}`,
    );
  }

  restoreAll();
}

// ---------------------------------------------------------------------------
// Tests: GET+POST /api/vehicles/[vin]/refresh (shopId from session, VIN scoped)
// ---------------------------------------------------------------------------

import {
  GET as refreshGET,
  POST as refreshPOST,
  __deps as refreshDeps,
} from "../app/api/vehicles/[vin]/refresh/route";

const ORIG_REFRESH = { ...refreshDeps };

async function testVehicleRefreshRoute() {
  console.log("\n[4] GET /api/vehicles/[vin]/refresh");

  const VIN_A = "1HGCM82633A004352"; // VIN owned by shop A
  const VIN_B = "2T1BURHE0JC037882"; // VIN owned by shop B

  // A minimal db stub that only returns a vehicle when shop matches
  function makeRefreshDb(vehicleShopId: number, vehicleVin: string) {
    function cursor() {
      const c: any = { sort: () => c, limit: () => c, project: () => c,
        next: async () => null, toArray: async () => [] };
      return c;
    }
    return {
      collection: (name: string) => ({
        findOne: async (filter: any) => {
          if (name === "vehicles") {
            // Match on vin AND shopId (either String or Number form)
            const filterVin = filter?.vin;
            const filterOr: any[] = filter?.$or ?? [];
            const matchesShop = filterOr.some(
              (entry: any) => Number(entry.shopId) === vehicleShopId,
            );
            if (filterVin === vehicleVin && matchesShop) {
              return { _id: "v1", vin: vehicleVin, shopId: vehicleShopId };
            }
            return null;
          }
          if (name === "tickets") return null;
          return null;
        },
        find: () => cursor(),
      }),
    } as any;
  }

  const ctxA = { params: { vin: VIN_A } };
  const ctxB = { params: { vin: VIN_B } };

  // 4a. No session → 401
  {
    refreshDeps.getSession = (async () => null) as any;
    refreshDeps.getDb = async () => makeRefreshDb(SHOP_A, VIN_A);
    const res = await refreshGET(
      new NextRequest(`http://localhost/api/vehicles/${VIN_A}/refresh`), ctxA,
    );
    ok("no session → 401", res.status === 401);
  }

  // 4b. Session is shop A, VIN belongs to shop B → 404 (blocked)
  {
    refreshDeps.getSession = async () => ({ shopId: SHOP_A } as any);
    // DB only has VIN_B for shop B — shop A query returns null
    refreshDeps.getDb = async () => makeRefreshDb(SHOP_B, VIN_B);
    const res = await refreshGET(
      new NextRequest(`http://localhost/api/vehicles/${VIN_B}/refresh`),
      { params: { vin: VIN_B } },
    );
    ok("cross-tenant VIN → 404", res.status === 404, `got ${res.status}`);
  }

  // 4c. Session is shop A, VIN belongs to shop A → 200
  {
    refreshDeps.getSession = async () => ({ shopId: SHOP_A } as any);
    refreshDeps.getDb = async () => makeRefreshDb(SHOP_A, VIN_A);
    const res = await refreshGET(
      new NextRequest(`http://localhost/api/vehicles/${VIN_A}/refresh`), ctxA,
    );
    ok("same-shop VIN → 200", res.status === 200, `got ${res.status}`);
  }

  // 4d. POST with a forged shopId body for shop B but session is shop A → 404
  {
    refreshDeps.getSession = async () => ({ shopId: SHOP_A } as any);
    refreshDeps.getDb = async () => makeRefreshDb(SHOP_B, VIN_B);
    const res = await refreshPOST(
      new NextRequest(`http://localhost/api/vehicles/${VIN_B}/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shopId: SHOP_B, customerId: "cust123" }),
      }),
      { params: { vin: VIN_B } },
    );
    ok(
      "forged body shopId for foreign VIN → 404 (session shop wins)",
      res.status === 404,
      `got ${res.status}`,
    );
  }

  Object.assign(refreshDeps, ORIG_REFRESH);
}

// ---------------------------------------------------------------------------
// Tests: POST /api/vehicle/close/[vin] (VIN must belong to session shop)
// ---------------------------------------------------------------------------

import {
  POST as closePOST,
  __deps as closeDeps,
} from "../app/api/vehicle/close/[vin]/route";

const ORIG_CLOSE = { ...closeDeps };

async function testVehicleCloseRoute() {
  console.log("\n[5] POST /api/vehicle/close/[vin]");

  const VIN_A = "1HGCM82633A004352";
  const VIN_B = "2T1BURHE0JC037882";

  function makeCloseDb(vehicleShopId: number, vehicleVin: string) {
    return {
      collection: (name: string) => ({
        findOne: async (filter: any) => {
          if (name === "vehicles") {
            const filterVin = filter?.vin;
            const filterOr: any[] = filter?.$or ?? [];
            const matchesShop = filterOr.some(
              (entry: any) => Number(entry.shopId) === vehicleShopId,
            );
            if (filterVin === vehicleVin && matchesShop) {
              return { _id: "v1", vin: vehicleVin, shopId: vehicleShopId };
            }
            return null;
          }
          return null;
        },
      }),
    } as any;
  }

  function makeCloseReq(vin: string) {
    return new Request(`http://localhost/api/vehicle/close/${vin}`, {
      method: "POST",
    });
  }

  // 5a. No session → 401; DB and insertEvent must not be reached
  {
    closeDeps.getSession = (async () => null) as any;
    closeDeps.getDb = (async () => { throw new Error("getDb must not be reached"); }) as any;
    closeDeps.insertEvent = (async () => { throw new Error("insertEvent must not be reached"); }) as any;
    const res = await closePOST(makeCloseReq(VIN_A), { params: Promise.resolve({ vin: VIN_A }) });
    ok("no session → 401", res.status === 401);
  }

  // 5b. Session is shop A, VIN belongs to shop B → 404; insertEvent not called
  {
    const eventsWritten: any[] = [];
    closeDeps.getSession = async () => ({ shopId: SHOP_A } as any);
    closeDeps.getDb = async () => makeCloseDb(SHOP_B, VIN_B);
    closeDeps.insertEvent = async (e: any) => { eventsWritten.push(e); };
    const res = await closePOST(makeCloseReq(VIN_B), { params: Promise.resolve({ vin: VIN_B }) });
    ok("cross-tenant VIN close → 404", res.status === 404, `got ${res.status}`);
    ok("no event written for foreign VIN", eventsWritten.length === 0);
  }

  // 5c. Session is shop A, VIN belongs to shop A → 200; event written with correct shopId
  {
    const eventsWritten: any[] = [];
    closeDeps.getSession = async () => ({ shopId: SHOP_A } as any);
    closeDeps.getDb = async () => makeCloseDb(SHOP_A, VIN_A);
    closeDeps.insertEvent = async (e: any) => { eventsWritten.push(e); };
    const res = await closePOST(makeCloseReq(VIN_A), { params: Promise.resolve({ vin: VIN_A }) });
    ok("same-shop VIN close → 200", res.status === 200, `got ${res.status}`);
    ok("event written once", eventsWritten.length === 1);
    ok(
      "event attributed to session shopId",
      eventsWritten[0]?.shopId === SHOP_A,
      `event.shopId=${eventsWritten[0]?.shopId}`,
    );
  }

  Object.assign(closeDeps, ORIG_CLOSE);
}

// ---------------------------------------------------------------------------
// Tests: POST /api/extension/analytics/push-to-ro (shop-scope enforcement)
// ---------------------------------------------------------------------------

import {
  POST as pushToROPOST,
  __deps as pushDeps,
} from "../app/api/extension/analytics/push-to-ro/route";

const ORIG_PUSH = { ...pushDeps };

function makeAuthResult(authorized: boolean, shopId: string) {
  return authorized
    ? { authorized: true, user: { email: "test@shop.com" }, error: null }
    : { authorized: false, user: null, error: "SHOP_FORBIDDEN", code: "SHOP_FORBIDDEN" };
}

function makePushReq(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/extension/analytics/push-to-ro", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer shopA-token" },
    body: JSON.stringify(body),
  });
}

async function testPushToRORoute() {
  console.log("\n[6] POST /api/extension/analytics/push-to-ro");

  const VALID_BODY = {
    shopId: SHOP_A,
    jobTitle: "Oil Change",
    jobSource: "plan",
    userId: "u1",
    vin: "1HGCM82633A004352",
  };

  // 6a. Valid Shop A token + Shop A body → 200; trackPushToRO called once with shopA id
  {
    const tracked: any[] = [];
    let authCalledWithShopId: string | undefined;

    pushDeps.validateExtensionToken = (async (req: any, requiredShopId?: string) => {
      authCalledWithShopId = requiredShopId;
      return makeAuthResult(true, String(SHOP_A));
    }) as any;
    pushDeps.buildAuthErrorBody = ((a: any) => ({ error: a.error })) as any;
    pushDeps.getAuthErrorStatus = ((_: any) => 401) as any;
    pushDeps.trackPushToRO = async (payload: any) => { tracked.push(payload); };

    const res = await pushToROPOST(makePushReq(VALID_BODY));
    ok("same-shop token + body → 200", res.status === 200, `got ${res.status}`);
    ok("trackPushToRO called once", tracked.length === 1);
    ok(
      "validateExtensionToken called with body shopId as requiredShopId",
      authCalledWithShopId === String(SHOP_A),
      `requiredShopId=${authCalledWithShopId}`,
    );
  }

  // 6b. Valid Shop A token + Shop B body → auth rejects; trackPushToRO never called
  {
    const tracked: any[] = [];

    pushDeps.validateExtensionToken = (async (_req: any, requiredShopId?: string) => {
      // Simulate the auth layer rejecting access: the Shop A token does NOT
      // have access to Shop B, so validateExtensionToken returns unauthorized.
      return makeAuthResult(false, String(SHOP_B));
    }) as any;
    pushDeps.trackPushToRO = async (payload: any) => { tracked.push(payload); };

    const res = await pushToROPOST(makePushReq({ ...VALID_BODY, shopId: SHOP_B }));
    ok(
      "valid Shop A token + Shop B body → 401 (cross-tenant rejected)",
      res.status === 401,
      `got ${res.status}`,
    );
    ok(
      "trackPushToRO NOT called for cross-tenant attempt",
      tracked.length === 0,
      `tracked ${tracked.length} events`,
    );
  }

  // 6c. Missing required fields → 400 before auth is invoked
  {
    let authCalled = false;
    pushDeps.validateExtensionToken = (async () => { authCalled = true; return makeAuthResult(true, "99"); }) as any;

    const res = await pushToROPOST(makePushReq({ shopId: SHOP_A })); // missing jobTitle + jobSource
    ok("missing required fields → 400", res.status === 400, `got ${res.status}`);
    ok("auth not called when required fields missing", !authCalled);
  }

  Object.assign(pushDeps, ORIG_PUSH);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("cross-tenant route auth regression tests");

  try {
    await testCustomerRoute();
    await testInspectRoute();
    await testCheckClosedOrdersRoute();
    await testVehicleRefreshRoute();
    await testVehicleCloseRoute();
    await testPushToRORoute();
  } finally {
    Object.assign(refreshDeps, ORIG_REFRESH);
    Object.assign(closeDeps, ORIG_CLOSE);
    Object.assign(pushDeps, ORIG_PUSH);
    restoreAll();
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll cross-tenant auth assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
