/**
 * A verified bootstrap session must stop working as soon as its existing MOS
 * account becomes inactive.
 *
 * Run: npx tsx tests/extension-auth-bootstrap-inactive.smoke.ts
 */
import { NextRequest } from "next/server";
import {
  __deps,
  validateExtensionToken,
} from "../lib/extension-auth";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

const original = { ...__deps };
let revoked: string | null = null;

async function run() {
  console.log("extension bootstrap inactive-user invalidation");
  __deps.lookupExtensionSession = async () =>
    ({
      status: "active",
      principal: {
        sessionId: "bootstrap-verified-session",
        userId: "disabled-user",
        shopId: 85,
        provider: "tekmetric",
        assurance: "verified",
        capabilities: ["read", "write", "provider_action"],
        expiresAt: new Date(Date.now() + 60_000),
      },
    }) as any;
  __deps.isIdentityPgCanonical = () => true;
  __deps.findUserById = async () =>
    ({
      _id: "disabled-user",
      email: "advisor@example.com",
      role: "owner",
      shopId: 85,
      shopIds: [85],
      disabled: true,
    }) as any;
  __deps.revokeExtensionSession = async (sessionId: string) => {
    revoked = sessionId;
  };

  const result = await validateExtensionToken(
    new NextRequest("http://localhost/api/extension/features", {
      headers: { authorization: "Bearer exts_verified_fixture" },
    }),
  );
  ok("disabled matched user is denied immediately", result.authorized === false);
  ok("disabled matched user returns TOKEN_REVOKED", result.code === "TOKEN_REVOKED");
  ok("disabled matched user's session is revoked", revoked === "bootstrap-verified-session");
}

run()
  .catch((error) => {
    failed += 1;
    console.error(error);
  })
  .finally(() => {
    Object.assign(__deps, original);
    if (failed > 0) process.exit(1);
    console.log("extension bootstrap inactive-user invalidation: PASS");
  });