/**
 * Focused smoke: first-class extension principal shop/provider scope enforcement.
 *
 * Proves that:
 *   1. A first-class platform_admin principal (role=platform_admin on the user
 *      doc) is still rejected with SHOP_FORBIDDEN (403) when the session token
 *      was issued for a different shop.
 *   2. A first-class principal with the right shop but wrong provider is
 *      rejected with PROVIDER_FORBIDDEN (403).
 *   3. A legacy token (isLegacy=true on the principal) is never rejected by
 *      requireExtensionPrincipalScope — null is returned.
 *   4. A matching first-class principal returns null (no failure).
 */
import {
  requireExtensionPrincipalScope,
  getAuthErrorStatus,
  buildAuthErrorBody,
} from "../lib/extension-auth";
import type { ExtensionAuthResult } from "../lib/extension-auth";
import type { ExtensionSessionPrincipal } from "../lib/extension-session";

let failed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makePrincipal(
  overrides: Partial<ExtensionSessionPrincipal> = {},
): ExtensionSessionPrincipal {
  return {
    sessionId: "sess-1",
    userId: "user-1",
    shopId: 7,
    provider: "tekmetric",
    assurance: "verified",
    capabilities: ["read", "write", "provider_action"],
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function makeAuth(
  principal: ExtensionSessionPrincipal,
  userRole = "owner",
): Pick<ExtensionAuthResult, "user" | "principal"> {
  const user: any = {
    _id: "user-1",
    id: "user-1",
    email: "test@example.com",
    role: userRole,
    shopId: 7,
    shopIds: [7],
    isPlatformAdmin: userRole === "platform_admin",
    extensionPrincipal: principal,
  };
  return { user, principal };
}

function run() {
  console.log("extension principal scope enforcement smoke");

  // ─── 1. platform_admin role, but first-class token scoped to shop 7 ───────
  // Token was issued for shop 7; route resolved shop 8. Must be rejected.
  {
    const principal = makePrincipal({ shopId: 7, provider: "tekmetric" });
    const auth = makeAuth(principal, "platform_admin");
    const result = requireExtensionPrincipalScope(auth, { shopId: 8, provider: "tekmetric" });
    ok(
      "platform_admin first-class principal: wrong shop → SHOP_FORBIDDEN",
      result !== null && result.code === "SHOP_FORBIDDEN",
      `got: ${JSON.stringify(result?.code)}`,
    );
    ok(
      "platform_admin first-class principal: wrong shop → 403 status",
      result !== null && getAuthErrorStatus(result) === 403,
      `got: ${result ? getAuthErrorStatus(result) : "n/a"}`,
    );
    ok(
      "buildAuthErrorBody preserves code",
      result !== null && buildAuthErrorBody(result).code === "SHOP_FORBIDDEN",
    );
  }

  // ─── 2. Correct shop, wrong provider ────────────────────────────────────────
  {
    const principal = makePrincipal({ shopId: 7, provider: "tekmetric" });
    const auth = makeAuth(principal, "owner");
    const result = requireExtensionPrincipalScope(auth, {
      shopId: 7,
      provider: "protractor",
    });
    ok(
      "first-class principal: right shop, wrong provider → PROVIDER_FORBIDDEN",
      result !== null && result.code === "PROVIDER_FORBIDDEN",
      `got: ${JSON.stringify(result?.code)}`,
    );
    ok(
      "first-class principal: provider mismatch → 403",
      result !== null && getAuthErrorStatus(result) === 403,
    );
  }

  // ─── 3. Legacy token always returns null ────────────────────────────────────
  {
    const principal = makePrincipal({
      shopId: undefined, // legacy principals have no shopId
      provider: undefined,
      isLegacy: true,
    });
    const auth = makeAuth(principal, "owner");
    const result = requireExtensionPrincipalScope(auth, { shopId: 999, provider: "tekmetric" });
    ok(
      "legacy principal: always returns null (no scope enforcement)",
      result === null,
    );
  }

  // ─── 4. Matching first-class principal returns null ─────────────────────────
  {
    const principal = makePrincipal({ shopId: 7, provider: "tekmetric" });
    const auth = makeAuth(principal, "owner");
    const result = requireExtensionPrincipalScope(auth, { shopId: 7, provider: "tekmetric" });
    ok(
      "first-class principal: matching shop+provider → null (allowed)",
      result === null,
    );
  }

  // ─── 5. platform_admin role, first-class token, correct shop → allowed ──────
  {
    const principal = makePrincipal({ shopId: 7, provider: "tekmetric" });
    const auth = makeAuth(principal, "platform_admin");
    const result = requireExtensionPrincipalScope(auth, { shopId: 7, provider: "tekmetric" });
    ok(
      "platform_admin first-class principal: correct shop → null (allowed)",
      result === null,
    );
  }

  // ─── 6. provider check is case-insensitive / shop-ware alias ───────────────
  {
    const principal = makePrincipal({ shopId: 7, provider: "shopware" });
    const auth = makeAuth(principal, "owner");
    const result = requireExtensionPrincipalScope(auth, { shopId: 7, provider: "shopware" });
    ok("shopware provider: matching → null", result === null);

    // The alias "shop-ware" should also be accepted (normalized to "shopware")
    const result2 = requireExtensionPrincipalScope(auth, { shopId: 7, provider: "shop-ware" });
    ok("shop-ware alias normalized → null", result2 === null);
  }

  // ─── 7. No principal at all → null (fail-open, no principal = no constraint) 
  {
    const auth: Pick<ExtensionAuthResult, "user" | "principal"> = {
      user: {
        _id: "u1",
        role: "owner",
        shopId: 5,
        shopIds: [5],
      },
      principal: undefined,
    };
    const result = requireExtensionPrincipalScope(auth, { shopId: 7, provider: "tekmetric" });
    ok(
      "no principal on auth result → null (legacy path, no enforcement)",
      result === null,
    );
  }

  if (failed) {
    console.error(`\nFAILED ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll principal scope checks passed.");
}

run();
