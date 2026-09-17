/**
 * Task #1287 route-boundary smoke coverage.
 *
 * The workflow route deliberately has no exported __deps seam.  This test
 * stubs auth and the repository before loading the route, then exercises the
 * actual handlers.  No Mongo/Postgres connection is permitted.
 *
 * Run:
 * NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
 *   npx tsx tests/autoflow-workflow-route-auth.smoke.ts
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
const repositoryStub = {
  listAutoflowWorkflowShops: async () => [],
  getAutoflowWorkflowDetails: async () => null,
  saveAutoflowWorkflow: async (_shopId: any, value: any) => value,
  resetAutoflowWorkflow: async () => {},
};
const authStub = {
  getSession: async () => session,
};

const originalLoad = (Module as any)._load;
(Module as any)._load = function (
  request: string,
  parent: any,
  isMain: boolean,
) {
  if (request === "@/lib/auth" || request.endsWith("/lib/auth")) {
    return authStub;
  }
  if (request.includes("data/repositories/autoflow-workflows")) {
    return repositoryStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

function request(
  method: "GET" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function main() {
  const route = await import("../app/api/platform-admin/autoflow-workflows/route");

  for (const [name, handler] of [
    ["GET", route.GET],
    ["PUT", route.PUT],
    ["DELETE", route.DELETE],
  ] as const) {
    session = null;
    const res =
      name === "GET"
        ? await handler(request("GET", "/api/platform-admin/autoflow-workflows"))
        : await handler(
            request(
              name,
              "/api/platform-admin/autoflow-workflows",
              name === "PUT" ? { shopId: 432, mapping: {} } : {},
            ),
          );
    ok(`${name} rejects unauthenticated requests`, res?.status === 401, `${res?.status}`);
  }

  session = {
    shopId: 1,
    email: "operator@example.com",
    role: "owner",
    isPlatformAdmin: false,
  };
  const forbidden = await route.GET(
    request("GET", "/api/platform-admin/autoflow-workflows"),
  );
  ok("GET rejects authenticated non-platform-admin requests", forbidden?.status === 403);

  session.isPlatformAdmin = true;
  const invalidJson = new NextRequest(
    "http://localhost/api/platform-admin/autoflow-workflows",
    { method: "PUT", body: "not json" },
  );
  const malformedJson = await route.PUT(invalidJson);
  ok("PUT rejects malformed JSON", malformedJson?.status === 400);

  const missingMapping = await route.PUT(
    request("PUT", "/api/platform-admin/autoflow-workflows", { shopId: 432 }),
  );
  ok("PUT rejects a missing mapping", missingMapping?.status === 400);

  for (const shopId of [null, "", {}, 0, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidShop = await route.PUT(
      request("PUT", "/api/platform-admin/autoflow-workflows", {
        shopId,
        mapping: { active: [], closed: [], excluded: [] },
      }),
    );
    ok(
      `PUT rejects invalid shop identity ${JSON.stringify(shopId)}`,
      invalidShop?.status === 400,
    );
  }

  const putSuccess = await route.PUT(
    request("PUT", "/api/platform-admin/autoflow-workflows", {
      shopId: 432,
      mapping: { active: ["Checkin"], closed: ["Close"], excluded: ["Appointment"] },
    }),
  );
  ok("PUT accepts a validated workflow mapping", putSuccess?.status === 200);

  const invalidDelete = await route.DELETE(
    request("DELETE", "/api/platform-admin/autoflow-workflows", {}),
  );
  ok("DELETE rejects a missing shop id", invalidDelete?.status === 400);

  const deleteSuccess = await route.DELETE(
    request("DELETE", "/api/platform-admin/autoflow-workflows", { shopId: 432 }),
  );
  ok("DELETE accepts a valid shop identity and resets defaults", deleteSuccess?.status === 200);

  const unknownShop = await route.GET(
    request("GET", "/api/platform-admin/autoflow-workflows?shopId=432"),
  );
  ok("GET reports an unknown AutoFlow shop as not found", unknownShop?.status === 404);

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