/**
 * Regression test for the super-admin gate on the Tekmetric Shop Migration
 * wizard's server-side API.
 *
 * Task #289 narrowed the gate from "any platform admin" to "super-admin
 * (owner) only" via the SUPER_ADMIN_EMAILS allowlist. The real security
 * boundary lives in `requireMigAdmin` (lib/tekmetric-migration/api-auth.ts):
 * the extension UI's `isSuperAdmin` flag and the sidepanel's
 * `data-super-admin-only` gate are convenience UX, not security. If a
 * future refactor reverts `requireMigAdmin` to checking
 * `user.role === 'platform_admin'`, this test must fail.
 *
 * We exercise one real route handler end-to-end (the token-status route)
 * via the `__deps` test seam on api-auth.ts so we can swap
 * `validateExtensionToken` and `isSuperAdmin` without standing up Mongo.
 *
 * Cases covered:
 *   (a) super-admin email                    → 200 (or non-401/403)
 *   (b) platform admin NOT in allowlist     → 403
 *   (c) regular shop user                   → 403
 *   (d) missing/invalid token               → 401
 *
 * Run: `npx tsx tests/tekmetric-migration-api-auth.smoke.ts`
 */

import { NextRequest } from "next/server";

import { __deps } from "../lib/tekmetric-migration/api-auth";
import type { ExtensionAuthResult } from "../lib/extension-auth";
import { isSuperAdmin, SUPER_ADMIN_EMAILS } from "../lib/super-admins";
import {
  GET as tokenStatusGET,
  __deps as tokenStatusDeps,
} from "../app/api/extension/tekmetric-migration/token-status/route";
import type { TokenStatus } from "../lib/tekmetric-migration/tokenCache";

interface FakeUser {
  _id: string;
  email: string | null;
  username: string | null;
  role: string;
  isPlatformAdmin: boolean;
}

const ORIGINAL_DEPS = { ...__deps };
const ORIGINAL_TOKEN_STATUS_DEPS = { ...tokenStatusDeps };

const FAKE_TOKEN_STATUS: TokenStatus = {
  smsShopId: 42,
  hasToken: false,
  ageMs: null,
  fresh: false,
  updatedAt: null,
  source: null,
};
// Stub out the only DB-backed dependency on the happy path so this smoke
// test runs in environments without MONGODB_URI configured.
tokenStatusDeps.getTokenStatus = async (
  smsShopId: number,
): Promise<TokenStatus> => ({ ...FAKE_TOKEN_STATUS, smsShopId });

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeReq(opts: { withAuth?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.withAuth) headers.authorization = "Bearer ext_test_token";
  return new NextRequest(
    "http://localhost/api/extension/tekmetric-migration/token-status?smsShopId=42",
    { headers },
  );
}

function stubAuth(user: FakeUser | null, error: string | null = null) {
  const result: ExtensionAuthResult = {
    user,
    authorized: !!user,
    error,
  };
  __deps.validateExtensionToken = async (
    _request: NextRequest,
  ): Promise<ExtensionAuthResult> => result;
  // Keep isSuperAdmin pointed at the real implementation so we're really
  // exercising the SUPER_ADMIN_EMAILS allowlist, not a stub.
  __deps.isSuperAdmin = isSuperAdmin;
}

async function run() {
  console.log("tekmetric-migration api-auth super-admin gate smoke");

  // Sanity: the allowlist is non-empty. Without this, every "is this user
  // a super admin?" check trivially fails and the test below would pass
  // for the wrong reasons.
  ok(
    "SUPER_ADMIN_EMAILS allowlist is non-empty",
    SUPER_ADMIN_EMAILS.length > 0,
  );
  const SUPER_EMAIL = SUPER_ADMIN_EMAILS[0];
  const NON_ALLOWLISTED_PLATFORM_ADMIN = "platform-admin@example.com";
  ok(
    "test fixture: NON_ALLOWLISTED_PLATFORM_ADMIN is not in the allowlist",
    !SUPER_ADMIN_EMAILS.includes(NON_ALLOWLISTED_PLATFORM_ADMIN.toLowerCase()),
  );

  // (a) Super-admin email in the allowlist → gate lets the request through.
  //     The token-status route then runs and returns a 200 with a JSON body
  //     describing the cache state. We don't care about the body shape here,
  //     only that it was NOT rejected with 401/403 by the auth gate.
  {
    stubAuth({
      _id: "u-super",
      email: SUPER_EMAIL,
      username: "super",
      role: "platform_admin",
      isPlatformAdmin: true,
    });
    const res = await tokenStatusGET(makeReq({ withAuth: true }));
    ok("super-admin: not 401", res.status !== 401, `status=${res.status}`);
    ok("super-admin: not 403", res.status !== 403, `status=${res.status}`);
    ok(
      "super-admin: status is 200 or 4xx-data (not auth)",
      res.status < 401 || res.status >= 500 || (res.status >= 400 && res.status !== 401 && res.status !== 403),
      `status=${res.status}`,
    );
  }

  // (b) Platform admin who is NOT in the SUPER_ADMIN_EMAILS allowlist →
  //     403. This is the case that catches the refactor regression: if
  //     someone reverts the gate to `role === 'platform_admin'`, this
  //     user would slip through and the assertion fails.
  {
    stubAuth({
      _id: "u-pa",
      email: NON_ALLOWLISTED_PLATFORM_ADMIN,
      username: "pa",
      role: "platform_admin",
      isPlatformAdmin: true,
    });
    const res = await tokenStatusGET(makeReq({ withAuth: true }));
    ok(
      "platform admin (not in allowlist): 403",
      res.status === 403,
      `status=${res.status} — regression: platform-admin role should NOT bypass the super-admin allowlist`,
    );
    const body = await res.json();
    ok(
      "platform admin (not in allowlist): error mentions super admin",
      typeof body.error === "string" && /super.?admin/i.test(body.error),
      `body=${JSON.stringify(body)}`,
    );
  }

  // (c) Regular shop user (no platform-admin role at all) → 403.
  {
    stubAuth({
      _id: "u-shop",
      email: "tech@shop.example.com",
      username: "tech",
      role: "shop_user",
      isPlatformAdmin: false,
    });
    const res = await tokenStatusGET(makeReq({ withAuth: true }));
    ok(
      "regular shop user: 403",
      res.status === 403,
      `status=${res.status}`,
    );
  }

  // (c2) Defense in depth: a user whose role string is literally
  //      'platform_admin' but whose email is null/undefined must still be
  //      rejected. `isSuperAdmin(null)` returns false.
  {
    stubAuth({
      _id: "u-noemail",
      email: null,
      username: "noemail",
      role: "platform_admin",
      isPlatformAdmin: true,
    });
    const res = await tokenStatusGET(makeReq({ withAuth: true }));
    ok(
      "platform admin with null email: 403",
      res.status === 403,
      `status=${res.status}`,
    );
  }

  // (d.1) Missing token: validateExtensionToken returns authorized=false
  //       with no user → 401.
  {
    stubAuth(null, "Missing authorization");
    const res = await tokenStatusGET(makeReq({ withAuth: false }));
    ok("missing token: 401", res.status === 401, `status=${res.status}`);
    const body = await res.json();
    ok(
      "missing token: error body propagates message",
      typeof body.error === "string" && body.error.length > 0,
    );
  }

  // (d.2) Invalid token: validateExtensionToken returns authorized=false
  //       with "Invalid token" → 401.
  {
    stubAuth(null, "Invalid token");
    const res = await tokenStatusGET(makeReq({ withAuth: true }));
    ok("invalid token: 401", res.status === 401, `status=${res.status}`);
    const body = await res.json();
    ok(
      "invalid token: error body says invalid",
      typeof body.error === "string" && /invalid/i.test(body.error),
      `body=${JSON.stringify(body)}`,
    );
  }

  // CORS headers must still be present on the deny paths so the extension
  // can read the error body. Re-check on a 403 since that's the new gate.
  {
    stubAuth({
      _id: "u-pa2",
      email: NON_ALLOWLISTED_PLATFORM_ADMIN,
      username: "pa2",
      role: "platform_admin",
      isPlatformAdmin: true,
    });
    const res = await tokenStatusGET(makeReq({ withAuth: true }));
    ok(
      "deny path keeps CORS headers",
      res.headers.get("Access-Control-Allow-Origin") === "*",
    );
  }

  Object.assign(__deps, ORIGINAL_DEPS);
  Object.assign(tokenStatusDeps, ORIGINAL_TOKEN_STATUS_DEPS);

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll tekmetric-migration api-auth gate assertions passed.");
  // Importing the route pulls in @/lib/mongo which lazily opens a client
  // pool; force-exit so the smoke test doesn't dangle on the open socket.
  process.exit(0);
}

run().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(2);
});
