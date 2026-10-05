/**
 * Task #1287 platform-admin AutoFlow number route coverage.
 *
 * The route is loaded with auth/repository module stubs so the actual handlers
 * are exercised without a Mongo connection.  This intentionally covers POST
 * and DELETE too; the mapping repository tests cover the lower-level atomic
 * claim behavior.
 */
import Module from "node:module";
import { NextRequest } from "next/server";

let failed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

let session: any = null;
const calls: { action: string; args: any[] }[] = [];
const repositoryStub = {
  listUnresolvedAutoflowNumbers: async () => [],
  listAutoflowShops: async () => [],
  listAutoflowIdentifierConflicts: async () => [],
  findShopByIdBasic: async (shopId: any) =>
    shopId === 432 ? { shopId, name: "Grand Rapids" } : null,
  findAutoflowIdentifierClaimConflicts: async (number: string) =>
    number === "999"
      ? [{ shopId: 900, shopName: "Other", field: "autoflow.shopNumbers" }]
      : [],
  attachAutoflowNumber: async (...args: any[]) => {
    calls.push({ action: "attach", args });
  },
  detachAutoflowNumber: async (...args: any[]) => {
    calls.push({ action: "detach", args });
  },
  AutoflowIdentifierConflictError: class extends Error {},
  AutoflowAliasNotOwnedError: class extends Error {},
};
const authStub = { getSession: async () => session };

const originalLoad = (Module as any)._load;
(Module as any)._load = function (
  request: string,
  parent: any,
  isMain: boolean,
) {
  if (request === "@/lib/auth" || request.endsWith("/lib/auth")) return authStub;
  if (request.includes("data/repositories/autoflow-unresolved-numbers")) {
    return repositoryStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

function req(
  method: "POST" | "DELETE",
  body: unknown,
): NextRequest {
  return new NextRequest("http://localhost/api/platform-admin/autoflow-numbers", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main() {
  const route = await import("../app/api/platform-admin/autoflow-numbers/route");

  session = null;
  const unauthorizedGet = await route.GET();
  ok("GET rejects unauthenticated requests", unauthorizedGet.status === 401);

  for (const method of ["POST", "DELETE"] as const) {
    session = null;
    const response = await route[method](
      req(method, method === "POST" ? { number: "615", shopId: 432 } : { number: "615", shopId: 432 }),
    );
    ok(`${method} rejects unauthenticated requests`, response.status === 401);
  }

  session = {
    shopId: 1,
    email: "operator@example.com",
    role: "owner",
    isPlatformAdmin: true,
  };
  const authorizedGet = await route.GET();
  ok("GET returns the admin mapping surface for platform admins", authorizedGet.status === 200);

  const invalidBodies = [
    { number: "", shopId: 432 },
    { number: "615", shopId: null },
    { number: "615", shopId: "" },
    { number: "615", shopId: {} },
    { number: "615", shopId: 0 },
    { number: "615", shopId: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const body of invalidBodies) {
    const response = await route.POST(req("POST", body));
    ok(
      `POST rejects invalid number/shop identity ${JSON.stringify(body)}`,
      response.status === 400,
      `${response.status}`,
    );
  }

  const missingShop = await route.POST(
    req("POST", { number: "615", shopId: 901 }),
  );
  ok("POST rejects an unknown shop", missingShop.status === 404);

  const conflict = await route.POST(
    req("POST", { number: "999", shopId: 432 }),
  );
  ok("POST rejects a conflicting number", conflict.status === 409);

  const success = await route.POST(
    req("POST", { number: "615", shopId: "432" }),
  );
  ok("POST accepts the unseen number for the selected shop", success.status === 200);
  ok(
    "POST keeps provider number separate from the internal MOS identity",
    calls.some(
      (call) =>
        call.action === "attach" &&
        call.args[0] === 432 &&
        call.args[1] === "615",
    ),
  );

  const invalidDelete = await route.DELETE(
    req("DELETE", { number: "615" }),
  );
  ok(
    "DELETE rejects a missing shop identity before calling detach",
    invalidDelete.status === 400 && !calls.some((call) => call.action === "detach"),
    `status=${invalidDelete.status}`,
  );

  const deleteSuccess = await route.DELETE(
    req("DELETE", { number: "615", shopId: 432 }),
  );
  ok("DELETE accepts the owning shop identity", deleteSuccess.status === 200);
  ok(
    "DELETE passes the selected MOS identity and provider number through",
    calls.some(
      (call) =>
        call.action === "detach" &&
        call.args[0] === 432 &&
        call.args[1] === "615",
    ),
  );

  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    (Module as any)._load = originalLoad;
  });