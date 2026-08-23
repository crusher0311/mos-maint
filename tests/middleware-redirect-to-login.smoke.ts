/**
 * Smoke test for src/middleware.ts redirectToLogin behavior (task #494).
 *
 * Run: `npx tsx tests/middleware-redirect-to-login.smoke.ts`
 *
 * Regression coverage for the P0 bug where the `redirectToLogin` helper was
 * called without being defined, throwing `ReferenceError` on every
 * unauthenticated page request in production.
 *
 * Asserts:
 *  1. Non-public page + no session cookie → 307 redirect to /login?next=...
 *  2. Non-public API path + no session cookie → 401 JSON (preserved branch).
 *  3. Public path (/login) is passed through untouched.
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

async function run() {
  console.log("middleware redirectToLogin smoke");

  // Ensure DEV_AUTO_LOGIN fall-through doesn't mask the bug under test.
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  delete process.env.DEV_AUTO_LOGIN;

  // (1) Non-public page without session cookie → 307 to /login?next=...
  {
    const req = new NextRequest("http://localhost/dashboard/vehicles");
    const res = await middleware(req);
    ok("page redirect returns response", !!res);
    ok("page redirect is 307", res!.status === 307);
    const loc = res!.headers.get("location") || "";
    ok(
      "redirects to /login with next param",
      loc.includes("/login") &&
        loc.includes(`next=${encodeURIComponent("/dashboard/vehicles")}`),
      `location=${loc}`,
    );
  }

  // (2) Non-public API path without session cookie → 401 JSON
  {
    const req = new NextRequest("http://localhost/api/shops");
    const res = await middleware(req);
    ok("api unauth is 401", res!.status === 401);
  }

  // (3) Public path passes through (no redirect)
  {
    const req = new NextRequest("http://localhost/login");
    const res = await middleware(req);
    ok("public /login passes through (not redirected)", res!.status !== 307);
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
