import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, __deps } from "../app/api/reports/locations/route-handler";
import { ReportingScopeError } from "../lib/reporting-scope";

async function main() {
  const request = new NextRequest("https://example.test/api/reports/locations?scope=enterprise&enterpriseId=test");
  let called = false;
  __deps.getSession = async () => null;
  __deps.resolveReportingScope = async () => { called = true; throw new Error("unexpected"); };
  assert.equal((await GET(request)).status, 401);
  assert.equal(called, false);
  __deps.getSession = async () => ({ email: "test@example.test" } as any);
  __deps.resolveReportingScope = async (session, scope) => {
    assert.equal(session.email, "test@example.test");
    assert.equal(scope.enterpriseId, "test");
    assert.equal(scope.kind, "enterprise");
    return { kind: "enterprise", shopIds: [7], shops: [{ shopId: 7, name: "Allowed", locationIdentifier: null }] };
  };
  const response = await GET(request);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { locations: [{ key: "7", label: "Allowed" }] });
  __deps.resolveReportingScope = async () => { throw new ReportingScopeError("private", 403); };
  assert.equal((await GET(request)).status, 403);
  __deps.resolveReportingScope = async () => { throw new Error("database secret"); };
  const failed = await GET(request);
  assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(await failed.json()), /database secret/);
  console.log("Authorized report locations: PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
