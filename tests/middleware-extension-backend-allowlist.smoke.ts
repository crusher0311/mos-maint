/**
 * Smoke test for src/middleware.ts extension-backend allowlist (Task #734).
 *
 * Run: `npx tsx tests/middleware-extension-backend-allowlist.smoke.ts`
 *
 * Locks in the Task #734 fix: the Chrome extension authenticates with a
 * `Bearer ext_` token, NOT a `session_token` cookie. The middleware's
 * no-cookie short-circuit returns a bare `{ error: "Unauthorized" }` 401
 * (no `code` field → `code=none` in the extension) BEFORE the route handler
 * runs. That gate blocked every extension request to MOS backend routes that
 * live outside `/api/extension/*` (apply-canned-job, estimate-assist, etc.),
 * so the route's own `validateExtensionToken` never got a chance to run —
 * the extension saw a deterministic 401, retried 5×, then falsely prompted
 * "Session may have expired" even with a fresh login.
 *
 * Asserts:
 *  1. Each allowlisted extension-backend path with an extension-style request
 *     (Bearer ext_ token, NO session cookie) is NOT short-circuited by the
 *     middleware — it falls through (NextResponse.next()) so the route's own
 *     auth runs.
 *  2. A control non-allowlisted /api path with the same request shape IS
 *     still 401'd by the middleware cookie gate (so we didn't open a hole).
 */
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function extRequest(pathname: string): NextRequest {
  // Extension shape: a Bearer ext_ token in the Authorization header and
  // NO session_token cookie. This is exactly what background.js sends.
  return new NextRequest(`http://localhost${pathname}`, {
    headers: { Authorization: "Bearer ext_smoke_token_value" },
  });
}

async function run() {
  console.log("middleware extension-backend allowlist smoke (Task #734)");

  // Don't let DEV_AUTO_LOGIN mask the short-circuit branch.
  process.env.NODE_ENV = "production";
  delete process.env.DEV_AUTO_LOGIN;

  // (1) Allowlisted extension-backend routes must NOT be 401'd by the
  // middleware cookie gate — they fall through to their own handler auth.
  const allowlisted = [
    "/api/tekmetric/apply-canned-job",
    "/api/protractor/apply-canned-job",
    "/api/estimate-assist/audit",
    "/api/estimate-assist/job-builder",
    "/api/vehicle/common-failures",
  ];
  for (const p of allowlisted) {
    const res = await middleware(extRequest(p));
    ok(
      `${p} is NOT 401'd by middleware (reaches handler auth)`,
      res!.status !== 401,
      `middleware returned status=${res!.status}`,
    );
  }

  // (2) Control: a non-allowlisted /api path with the SAME extension-style
  // request (Bearer token, no cookie) is still short-circuited to 401. The
  // Bearer header alone must never satisfy the cookie gate for arbitrary
  // routes — only the explicitly allowlisted ones fall through.
  const stillGated = [
    "/api/shops",
    "/api/vehicles/abc",
    "/api/tekmetric/some-other-route",
  ];
  for (const p of stillGated) {
    const res = await middleware(extRequest(p));
    ok(`${p} is still 401'd by middleware`, res!.status === 401, `status=${res!.status}`);
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
