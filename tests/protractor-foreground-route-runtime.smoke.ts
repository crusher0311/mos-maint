/**
 * Executable trust-boundary coverage for representative foreground routes.
 *
 * Unlike the inventory test, this imports the handlers and invokes them with
 * mocked sibling dependencies.  No Protractor client or Mongo connection is
 * loaded: the integration mocks assert that authorized calls receive the
 * exact server-resolved numeric shop ID while denied requests never reach a
 * transport-facing function.
 */
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";
import {
  getProtractorInteractiveTransportContext,
} from "../lib/integrations/protractor/interactive-context";

const Module = require("module");
const originalLoad = Module._load;

type Session = { shopId: number | string; email: string };
type Mode = "authorized" | "unauthorized";

let dashboardSession: Session | null = {
  shopId: "42",
  email: "advisor@example.test",
};
let extensionMode: Mode = "authorized";
let extensionGuardMode: "authorized" | "unauthorized" | "wrong-shop" | "wrong-provider" =
  "authorized";

const transportCalls: Array<{
  operation: string;
  argumentShopId: number;
  contextShopId: number | undefined;
}> = [];

function recordTransport(operation: string, shopId: number): void {
  const context = getProtractorInteractiveTransportContext();
  transportCalls.push({
    operation,
    argumentShopId: shopId,
    contextShopId: context?.shopId,
  });
  assert.equal(context?.active, true, `${operation} must run in an active context`);
}

const mocks = new Map<string, any>();

mocks.set("@/lib/auth", {
  getSession: async () => dashboardSession,
});

mocks.set("@/lib/idempotent-create-id", {
  resolveClientRequestId: (
    kind: string,
    shopId: number,
    email: string,
    clientRequestId?: string,
  ) => `${kind}-${shopId}-${email}-${clientRequestId || "none"}`,
});

mocks.set("@/lib/with-upstream-timeout", {
  withUpstreamTimeout: async <T>(promise: Promise<T>) => promise,
});

mocks.set("@/lib/extension-route-wrapper", {
  // The route wrapper is orthogonal to provider admission.  Identity keeps
  // this test focused on the handler's status/body and trust-boundary order.
  withExtensionErrorMarker: (handler: any) => handler,
});

mocks.set("@/lib/extension-auth", {
  validateExtensionToken: async () => {
    if (extensionMode === "unauthorized") {
      return { authorized: false, user: null, reason: "missing_token" };
    }
    return {
      authorized: true,
      user: { email: "advisor@example.test", role: "user" },
    };
  },
  getUserShopIds: () => [42],
  getAuthErrorStatus: () => 401,
  buildAuthErrorBody: () => ({ error: "Unauthorized" }),
  requireExtensionPrincipalScope: () => null,
});

mocks.set("@/lib/extension-route-guard", {
  guardExtensionShopRequest: async () => {
    if (extensionGuardMode === "unauthorized") {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Unauthorized" },
          { status: 401, headers: { "Access-Control-Allow-Origin": "*" } },
        ),
      };
    }
    if (extensionGuardMode === "wrong-shop") {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Not authorized for this shop" },
          { status: 403, headers: { "Access-Control-Allow-Origin": "*" } },
        ),
      };
    }
    if (extensionGuardMode === "wrong-provider") {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Provider scope mismatch", code: "PROVIDER_FORBIDDEN" },
          { status: 403, headers: { "Access-Control-Allow-Origin": "*" } },
        ),
      };
    }
    return { ok: true, mosShopId: 42, user: { email: "advisor@example.test" } };
  },
});

mocks.set("@/lib/data/repositories/canned-jobs", {
  insertCannedJobApplication: async () => ({ insertedId: "application-1" }),
});

mocks.set("@/lib/extension-analytics", {
  trackPushToRO: async () => undefined,
});

mocks.set("@/lib/integrations/protractor", {
  createContact: async (shopId: number) => {
    recordTransport("createContact", shopId);
    return {
      ok: true,
      contactId: "contact-1",
      contact: { ID: "contact-1", Name: { FirstName: "Ada", LastName: "Lovelace" } },
    };
  },
  fetchVehiclesByOwner: async (shopId: number) => {
    recordTransport("fetchVehiclesByOwner", shopId);
    return {
      ok: true,
      vehicles: [{ ID: "vehicle-1", VIN: "VIN-1", Year: 2020, Make: "Test", Model: "Roadster" }],
    };
  },
  resolveProtractorConfig: async () => ({
    configured: true,
    connectionId: "connection-42",
    apiKey: "not-used-by-mock",
  }),
  protractorFetch: async (path: string, _config: unknown, _opts: unknown, _retry: number, shopId: number) => {
    recordTransport("protractorFetch", shopId);
    assert.match(path, /WorkOrder/);
    return {
      ok: true,
      data: [{ ID: "wo-1", WorkOrderNumber: "RO-42", Completed: false }],
    };
  },
  applyCannedJobToWorkOrder: async (shopId: number) => {
    recordTransport("applyCannedJobToWorkOrder", shopId);
    return {
      ok: true,
      servicePackage: { ID: "package-1", Title: "Inspection" },
    };
  },
  fetchCannedJobsWithCache: async (
    shopId: number,
    _maxAgeMs?: number,
    options?: { forceRefresh?: boolean },
  ) => {
    recordTransport("fetchCannedJobsWithCache", shopId);
    if (options?.forceRefresh) {
      return {
        ok: false,
        error: "PROTRACTOR_CANNED_JOBS_FORCE_REFRESH_UNAVAILABLE_DURING_TIMED_TRIAL",
      };
    }
    return { ok: true, cannedJobs: [], source: "cache" };
  },
  fetchVehicleByVin: async () => {
    throw new Error("VIN lookup should not run in RO-number test");
  },
  fetchWorkOrdersForVehicle: async () => {
    throw new Error("vehicle WO lookup should not run in RO-number test");
  },
});

Module._load = function (request: string, parent: any, ...rest: any[]) {
  if (mocks.has(request)) return mocks.get(request);
  return originalLoad.call(this, request, parent, ...rest);
};

const createContactRoute = require("../app/api/dashboard/protractor/create-contact/route");
const vehiclesRoute = require("../app/api/extension/protractor/vehicles/route");
const applyCannedRoute = require("../app/api/extension/jobs/apply-canned/route");
const cannedJobsRoute = require("../app/api/protractor/canned-jobs/route");

function request(
  url: string,
  init?: ConstructorParameters<typeof NextRequest>[1],
): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

async function json(response: Response): Promise<any> {
  return response.json();
}

async function run(): Promise<void> {
  // Dashboard create-contact: auth denial happens before body/upstream work.
  dashboardSession = null;
  transportCalls.length = 0;
  const unauthCreate = await createContactRoute.POST(
    request("/api/dashboard/protractor/create-contact", {
      method: "POST",
      body: JSON.stringify({ firstName: "Ada", lastName: "Lovelace" }),
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(unauthCreate.status, 401);
  assert.deepEqual(await json(unauthCreate), { error: "Unauthorized" });
  assert.equal(transportCalls.length, 0, "unauthenticated create must not reach transport");

  dashboardSession = { shopId: "42", email: "advisor@example.test" };
  const createResponse = await createContactRoute.POST(
    request("/api/dashboard/protractor/create-contact", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Ada",
        lastName: "Lovelace",
        clientRequestId: "create-1",
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(createResponse.status, 200);
  assert.deepEqual(await json(createResponse), {
    success: true,
    contactId: "contact-1",
    contact: { ID: "contact-1", Name: { FirstName: "Ada", LastName: "Lovelace" } },
  });
  assert.deepEqual(transportCalls, [
    { operation: "createContact", argumentShopId: 42, contextShopId: 42 },
  ]);

  // Extension vehicle read: the guard owns authentication, shop membership,
  // and provider binding; every denial must precede the scoped fetch.
  for (const denied of ["unauthorized", "wrong-shop", "wrong-provider"] as const) {
    extensionGuardMode = denied;
    transportCalls.length = 0;
    const response = await vehiclesRoute.GET(
      request("/api/extension/protractor/vehicles?shopId=42&provider=protractor&ownerId=owner-1"),
    );
    assert.equal(response.status, denied === "unauthorized" ? 401 : 403);
    assert.equal(transportCalls.length, 0, `${denied} vehicle read must not reach transport`);
  }

  extensionGuardMode = "authorized";
  transportCalls.length = 0;
  const vehiclesResponse = await vehiclesRoute.GET(
    request("/api/extension/protractor/vehicles?shopId=42&provider=protractor&ownerId=owner-1"),
  );
  assert.equal(vehiclesResponse.status, 200);
  assert.deepEqual(await json(vehiclesResponse), {
    vehicles: [{ id: "vehicle-1", vin: "VIN-1", year: 2020, make: "Test", model: "Roadster", submodel: "", engine: "", color: "", plate: "", odometer: null }],
  });
  assert.deepEqual(transportCalls, [
    { operation: "fetchVehiclesByOwner", argumentShopId: 42, contextShopId: 42 },
  ]);

  // Apply-canned has independent token, shop, and provider boundaries.  These
  // are intentionally tested against the handler rather than only the guard.
  const applyBody = {
    shopId: 42,
    provider: "protractor",
    roNumber: "RO-42",
    cannedJobId: "job-1",
    cannedJobTitle: "Inspection",
  };

  extensionMode = "unauthorized";
  transportCalls.length = 0;
  const unauthApply = await applyCannedRoute.POST(
    request("/api/extension/jobs/apply-canned", {
      method: "POST",
      body: JSON.stringify(applyBody),
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(unauthApply.status, 401);
  assert.deepEqual(await json(unauthApply), { error: "Unauthorized" });
  assert.equal(transportCalls.length, 0);

  extensionMode = "authorized";
  for (const deniedBody of [
    { ...applyBody, shopId: 43 },
    { ...applyBody, provider: "tekmetric" },
  ]) {
    transportCalls.length = 0;
    const deniedApply = await applyCannedRoute.POST(
      request("/api/extension/jobs/apply-canned", {
        method: "POST",
        body: JSON.stringify(deniedBody),
        headers: { "content-type": "application/json" },
      }),
    );
    assert.equal(deniedApply.status, 403);
    assert.equal(transportCalls.length, 0, "wrong scope must not reach apply transport");
  }

  transportCalls.length = 0;
  const applyResponse = await applyCannedRoute.POST(
    request("/api/extension/jobs/apply-canned", {
      method: "POST",
      body: JSON.stringify(applyBody),
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(applyResponse.status, 200);
  assert.deepEqual(await json(applyResponse), {
    success: true,
    jobName: "Inspection",
    workOrderId: "wo-1",
    servicePackage: { ID: "package-1", Title: "Inspection" },
    servicePackageId: "package-1",
  });
  assert.deepEqual(transportCalls, [
    { operation: "protractorFetch", argumentShopId: 42, contextShopId: 42 },
    { operation: "applyCannedJobToWorkOrder", argumentShopId: 42, contextShopId: 42 },
  ]);

  // A timed-trial force refresh is an explicit conflict, not a generic
  // upstream 500.  The handler preserves the stable transport error code.
  transportCalls.length = 0;
  const refreshResponse = await cannedJobsRoute.GET(
    request("/api/protractor/canned-jobs?refresh=true"),
  );
  assert.equal(refreshResponse.status, 409);
  assert.deepEqual(await json(refreshResponse), {
    error: "PROTRACTOR_CANNED_JOBS_FORCE_REFRESH_UNAVAILABLE_DURING_TIMED_TRIAL",
    code: "PROTRACTOR_CANNED_JOBS_FORCE_REFRESH_UNAVAILABLE_DURING_TIMED_TRIAL",
  });
  assert.deepEqual(transportCalls, [
    { operation: "fetchCannedJobsWithCache", argumentShopId: 42, contextShopId: 42 },
  ]);
}

run()
  .then(() => console.log("foreground Protractor mocked handler coverage passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });