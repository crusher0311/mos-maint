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
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  AutoflowWorkflowRevisionConflictError,
  InvalidAutoflowWorkflowMappingError,
  isValidAutoflowWorkflowRevision,
} from "../lib/data/repositories/autoflow-workflows";

let failed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

let session: any = null;
const repositoryStub: any = {
  listAutoflowWorkflowShops: async () => [],
  getAutoflowWorkflowDetails: async () => null,
  isValidAutoflowWorkflowRevision,
  InvalidAutoflowWorkflowMappingError,
  AutoflowWorkflowRevisionConflictError,
  saveAutoflowWorkflow: async (_shopId: any, value: any, expectedRevision: number) => ({
    mapping: value,
    revision: expectedRevision + 1,
  }),
  resetAutoflowWorkflow: async (_shopId: any, expectedRevision: number) => ({
    mapping: null,
    revision: expectedRevision + 1,
  }),
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
              name === "PUT" ? { shopId: 432, mapping: {}, expectedRevision: 0 } : { shopId: 432, expectedRevision: 0 },
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
    request("PUT", "/api/platform-admin/autoflow-workflows", { shopId: 432, expectedRevision: 0 }),
  );
  ok("PUT rejects a missing mapping", missingMapping?.status === 400);

  for (const shopId of [null, "", {}, 0, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidShop = await route.PUT(
      request("PUT", "/api/platform-admin/autoflow-workflows", {
        shopId,
        mapping: { active: [], closed: [], excluded: [] },
        expectedRevision: 0,
      }),
    );
    ok(
      `PUT rejects invalid shop identity ${JSON.stringify(shopId)}`,
      invalidShop?.status === 400,
    );
  }

  for (const revision of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER, "0"]) {
    const invalidRevision = await route.PUT(
      request("PUT", "/api/platform-admin/autoflow-workflows", {
        shopId: 432,
        mapping: { active: [], closed: [], excluded: [] },
        expectedRevision: revision,
      }),
    );
    assert.ok(invalidRevision);
    ok(`PUT rejects invalid revision ${String(revision)}`, invalidRevision.status === 400);
    const invalidDeleteRevision = await route.DELETE(
      request("DELETE", "/api/platform-admin/autoflow-workflows", {
        shopId: 432,
        expectedRevision: revision,
      }),
    );
    assert.ok(invalidDeleteRevision);
    ok(`DELETE rejects invalid revision ${String(revision)}`, invalidDeleteRevision.status === 400);
  }

  const putSuccess = await route.PUT(
    request("PUT", "/api/platform-admin/autoflow-workflows", {
      shopId: 432,
      mapping: { active: ["Checkin"], closed: ["Close"], excluded: ["Appointment"] },
      expectedRevision: 0,
    }),
  );
  assert.ok(putSuccess);
  const putBody = await putSuccess.json();
  ok(
    "PUT returns mapping and incremented revision",
    putSuccess?.status === 200 && putBody.revision === 1 &&
      putBody.mapping.active[0] === "Checkin",
  );

  const invalidDelete = await route.DELETE(
    request("DELETE", "/api/platform-admin/autoflow-workflows", {}),
  );
  ok("DELETE rejects a missing shop id", invalidDelete?.status === 400);

  const deleteSuccess = await route.DELETE(
    request("DELETE", "/api/platform-admin/autoflow-workflows", { shopId: 432, expectedRevision: 1 }),
  );
  assert.ok(deleteSuccess);
  const deleteBody = await deleteSuccess.json();
  ok(
    "DELETE returns null mapping and incremented revision",
    deleteSuccess?.status === 200 && deleteBody.mapping === null && deleteBody.revision === 2,
  );

  repositoryStub.saveAutoflowWorkflow = async () => {
    throw new AutoflowWorkflowRevisionConflictError();
  };
  const conflict = await route.PUT(
    request("PUT", "/api/platform-admin/autoflow-workflows", {
      shopId: 432,
      mapping: { active: [], closed: [], excluded: [] },
      expectedRevision: 0,
    }),
  );
  assert.ok(conflict);
  const conflictBody = await conflict.json();
  ok(
    "stale PUT returns the stable conflict contract",
    conflict.status === 409 && conflictBody.code === "WORKFLOW_REVISION_CONFLICT",
  );
  repositoryStub.resetAutoflowWorkflow = async () => {
    throw new AutoflowWorkflowRevisionConflictError();
  };
  const resetConflict = await route.DELETE(
    request("DELETE", "/api/platform-admin/autoflow-workflows", {
      shopId: 432,
      expectedRevision: 1,
    }),
  );
  assert.ok(resetConflict);
  const resetConflictBody = await resetConflict.json();
  ok(
    "stale DELETE returns the stable conflict contract",
    resetConflict.status === 409 &&
      resetConflictBody.code === "WORKFLOW_REVISION_CONFLICT",
  );

  repositoryStub.getAutoflowWorkflowDetails = async () => ({
    shop: { shopId: 432, name: "Legacy Shop" },
    mapping: null,
    revision: 0,
    observed: [],
    bounds: { lookbackDays: 90, maxEvents: 5_000, maxLabels: 100 },
  });
  const legacyGet = await route.GET(
    request("GET", "/api/platform-admin/autoflow-workflows?shopId=432"),
  );
  assert.ok(legacyGet);
  const legacyGetBody = await legacyGet.json();
  ok(
    "GET exposes the legacy zero revision",
    legacyGet.status === 200 && legacyGetBody.revision === 0 &&
      legacyGetBody.mapping === null,
  );

  repositoryStub.getAutoflowWorkflowDetails = async () => {
    throw new InvalidAutoflowWorkflowMappingError(7);
  };
  const malformedGet = await route.GET(
    request("GET", "/api/platform-admin/autoflow-workflows?shopId=432"),
  );
  assert.ok(malformedGet);
  const malformedGetBody = await malformedGet.json();
  ok(
    "malformed mapping GET supplies the revision needed to reset",
    malformedGet.status === 409 &&
      malformedGetBody.code === "INVALID_WORKFLOW_MAPPING" &&
      malformedGetBody.revision === 7,
  );

  repositoryStub.getAutoflowWorkflowDetails = async () => null;
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