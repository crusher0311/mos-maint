import { NextRequest } from "next/server";
import * as auth from "../lib/extension-auth";
import * as sessions from "../lib/extension-session";
import {
  __deps as actionGrantDeps,
  consumeExtensionActionGrant,
  isValidExtensionProviderAction,
  issueExtensionActionGrant,
  verifyExtensionActionGrant,
} from "../lib/extension-action-grant";
import { checkExtensionWritePermission } from "../lib/extension-write-guard";
import { allPolicyEntries } from "../lib/extension-route-policy";
import { POST as actionGrantPOST } from "../app/api/extension/action-grant/route";

let failed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function request(path: string, method = "GET", token = "exts_test") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

function jsonPost(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function run() {
  console.log("secure extension sessions smoke");

  const originalSessionDeps = { ...sessions.__deps };
  const originalAuthDeps = { ...auth.__deps };
  const originalActionGrantDeps = { ...actionGrantDeps };
  const originalSecret = process.env.SESSION_SECRET;
  let inserted: any = null;
  let touched = "";
  sessions.__deps.insertExtensionSession = (async (row: any) => {
    inserted = row;
    return { ...row, revokedAt: null };
  }) as any;
  sessions.__deps.findExtensionSessionByTokenHash = (async () => null) as any;
  sessions.__deps.touchExtensionSession = (async (id: string) => {
    touched = id;
  }) as any;
  sessions.__deps.revokeExtensionSessionById = (async () => {}) as any;

  try {
    const issued = await sessions.issueBasicExtensionSession({
      shopId: 7,
      provider: "tekmetric",
    });
    ok("new token is opaque and uses exts_ prefix", issued.token.startsWith("exts_"));
    ok("plaintext token is never persisted", inserted.tokenHash !== issued.token);
    ok(
      "persisted token hash is deterministic SHA-256",
      inserted.tokenHash === sessions.hashExtensionSessionToken(issued.token) &&
        inserted.tokenHash.length === 64,
    );
    ok("Basic session has read-only capabilities", JSON.stringify(inserted.capabilities) === '["read"]');
    ok("Basic session has no user identity", inserted.userId === null);
    ok(
      "Basic expiry is short and predictable",
      inserted.expiresAt.getTime() - inserted.createdAt.getTime() === 8 * 60 * 60 * 1000,
    );

    const basicPrincipal = issued.principal;
    auth.__deps.lookupExtensionSession = (async () => ({
      status: "active",
      principal: {
        ...basicPrincipal,
        capabilities: ["read", "write", "provider_action", "admin"],
      },
    })) as any;

    const readResult = await auth.validateExtensionToken(
      request("/api/extension/features"),
    );
    ok("Basic principal can access classified reads", readResult.authorized);
    ok("Basic principal is presented as role user", readResult.user?.role === "user");
    ok("Basic principal does not create/use a real user id", String(readResult.user?._id).startsWith("basic:"));

    const writeResult = await auth.validateExtensionToken(
      request("/api/extension/preferences", "PUT"),
    );
    ok("Basic principal gets 403 capability failure on writes", !writeResult.authorized && auth.getAuthErrorStatus(writeResult) === 403);
    ok("Basic write failure has stable capability code", writeResult.code === "CAPABILITY_REQUIRED");
    ok("write guard also rejects Basic represented as role user", checkExtensionWritePermission(readResult.user) !== null);

    const basicAuth = {
      user: readResult.user,
      authorized: true,
      error: null,
      principal: readResult.principal,
    };
    const restrictedEntries = allPolicyEntries().filter((entry) =>
      entry.tiers.some((tier) =>
        tier === "write" || tier === "provider_action" || tier === "admin"
      ),
    );
    const restrictedFailures = restrictedEntries.filter((entry) => {
      const concretePath = entry.pathname.replace("[id]", "test-run");
      const result = auth.enforceExtensionRoutePolicy(
        request(concretePath, entry.method),
        basicAuth,
      );
      return result.authorized || auth.getAuthErrorStatus(result) !== 403;
    });
    ok(
      `complete Basic 403 matrix covers ${restrictedEntries.length} restricted route methods`,
      restrictedFailures.length === 0,
      restrictedFailures.map((entry) => `${entry.method} ${entry.pathname}`).join(", "),
    );

    const wrongShop = await auth.validateExtensionToken(
      request("/api/extension/features"),
      "8",
    );
    ok("shop-bound session fails closed on another shop", wrongShop.code === "SHOP_FORBIDDEN" && auth.getAuthErrorStatus(wrongShop) === 403);

    auth.__deps.lookupExtensionSession = (async () => ({ status: "expired" })) as any;
    const expired = await auth.validateExtensionToken(request("/api/extension/features"));
    ok("expired session is rejected predictably", expired.code === "TOKEN_EXPIRED");

    auth.__deps.lookupExtensionSession = (async () => ({ status: "revoked" })) as any;
    const revoked = await auth.validateExtensionToken(request("/api/extension/features"));
    ok("revoked session is rejected predictably", revoked.code === "TOKEN_REVOKED");

    const verifiedPrincipal: sessions.ExtensionSessionPrincipal = {
      sessionId: "verified-1",
      userId: "user-1",
      shopId: 7,
      provider: "tekmetric",
      assurance: "verified",
      capabilities: ["read", "write", "provider_action"],
      expiresAt: new Date(Date.now() + 60_000),
    };
    auth.__deps.lookupExtensionSession = (async () => ({
      status: "active",
      principal: verifiedPrincipal,
    })) as any;
    auth.__deps.isIdentityPgCanonical = () => true;
    auth.__deps.findUserById = (async () => ({
      _id: "user-1",
      id: "user-1",
      email: "verified@example.com",
      emailLower: "verified@example.com",
      role: "owner",
      shopId: 7,
      shopIds: [7, 8],
      isPlatformAdmin: false,
      mustChangePassword: false,
      defaultExtensionTab: "plan",
    })) as any;
    const verified = await auth.validateExtensionToken(
      request("/api/extension/preferences", "PUT"),
    );
    ok("verified principal keeps matched user's role", verified.user?.role === "owner");
    ok("verified principal keeps matched user's preferences", verified.user?.defaultExtensionTab === "plan");
    ok("verified principal can use assigned mutation capability", verified.authorized);
    ok("new session remains scoped to one shop", JSON.stringify(auth.getUserShopIds(verified.user)) === '["7"]');

    auth.__deps.findUserById = (async () => ({
      _id: "user-1",
      id: "user-1",
      email: "verified@example.com",
      role: "viewer",
      shopId: 7,
      shopIds: [7],
      readOnly: true,
    })) as any;
    const demoted = await auth.validateExtensionToken(
      request("/api/extension/preferences", "PUT"),
    );
    ok(
      "verified session immediately honors a current read-only role",
      !demoted.authorized &&
        demoted.code === "CAPABILITY_REQUIRED" &&
        auth.getAuthErrorStatus(demoted) === 403,
    );

    sessions.__deps.findExtensionSessionByTokenHash = (async () => ({
      ...inserted,
      id: "lookup-1",
      assurance: "basic",
      capabilities: ["read"],
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    })) as any;
    const lookedUp = await sessions.lookupExtensionSession(issued.token);
    await new Promise((resolve) => setTimeout(resolve, 0));
    ok("active lookup touches use tracking", lookedUp.status === "active" && touched === "lookup-1");

    process.env.SESSION_SECRET = "extension-action-grant-test-secret";
    const addToRoAction = "tekmetric:post:/api/shop/id/job";
    ok(
      "released Tekmetric Add to RO action syntax is valid",
      isValidExtensionProviderAction(addToRoAction),
    );
    ok(
      "endpoint-scoped Tekmetric mutation methods all use the bounded action contract",
      ["post", "put", "patch", "delete"].every((method) => {
        const action = `tekmetric:${method}:/api/shop/id/job`;
        const methodGrant = issueExtensionActionGrant({
          sessionId: "verified-1",
          shopId: 7,
          provider: "tekmetric",
          action,
          now: new Date("2026-08-21T12:00:00Z"),
        });
        return verifyExtensionActionGrant(methodGrant.grant, {
          sessionId: "verified-1",
          shopId: 7,
          provider: "tekmetric",
          action,
          now: new Date("2026-08-21T12:00:30Z"),
        }) !== null;
      }),
    );
    ok(
      "malformed and overlong provider actions remain rejected",
      [
        "",
        "tekmetric:post:/api/shop/{id}/job",
        "tekmetric:post:/api/shop/id/job?repairOrderId=123",
        "tekmetric:post:/api/shop/id/job\nother",
        `tekmetric:post:/${"a".repeat(80)}`,
      ].every((action) => !isValidExtensionProviderAction(action)),
    );

    const missingActionResponse = await actionGrantPOST(
      jsonPost("/api/extension/action-grant", {
        provider: "tekmetric",
        smsShopId: "7",
      }),
    );
    const missingActionBody = await missingActionResponse.json();
    ok(
      "missing action returns a stable client error",
      missingActionResponse.status === 400 &&
        missingActionBody.code === "PROVIDER_ACTION_INVALID",
    );
    const malformedActionResponse = await actionGrantPOST(
      jsonPost("/api/extension/action-grant", {
        provider: "tekmetric",
        smsShopId: "7",
        action: "tekmetric:post:/api/shop/{id}/job",
      }),
    );
    const malformedActionBody = await malformedActionResponse.json();
    ok(
      "malformed action returns a stable client error instead of a 500",
      malformedActionResponse.status === 400 &&
        malformedActionBody.code === "PROVIDER_ACTION_INVALID",
    );
    const releasedActionResponse = await actionGrantPOST(
      jsonPost("/api/extension/action-grant", {
        provider: "tekmetric",
        smsShopId: "7",
        action: addToRoAction,
      }),
    );
    ok(
      "released Add to RO action passes route validation and reaches authentication",
      releasedActionResponse.status === 401,
      `got ${releasedActionResponse.status}`,
    );

    const actionGrant = issueExtensionActionGrant({
      sessionId: "verified-1",
      shopId: 7,
      provider: "tekmetric",
      action: addToRoAction,
      now: new Date("2026-08-21T12:00:00Z"),
    });
    ok(
      "action grant verifies only for exact action/shop/provider/session",
      verifyExtensionActionGrant(actionGrant.grant, {
        sessionId: "verified-1",
        shopId: 7,
        provider: "tekmetric",
        action: addToRoAction,
        now: new Date("2026-08-21T12:00:30Z"),
      }) !== null,
    );
    ok(
      "action grant rejects cross-shop replay",
      verifyExtensionActionGrant(actionGrant.grant, {
        sessionId: "verified-1",
        shopId: 8,
        provider: "tekmetric",
        action: addToRoAction,
        now: new Date("2026-08-21T12:00:30Z"),
      }) === null,
    );
    ok(
      "action grant rejects cross-session replay",
      verifyExtensionActionGrant(actionGrant.grant, {
        sessionId: "verified-2",
        shopId: 7,
        provider: "tekmetric",
        action: addToRoAction,
        now: new Date("2026-08-21T12:00:30Z"),
      }) === null,
    );
    ok(
      "action grant expires quickly",
      verifyExtensionActionGrant(actionGrant.grant, {
        sessionId: "verified-1",
        shopId: 7,
        provider: "tekmetric",
        action: addToRoAction,
        now: new Date("2026-08-21T12:02:01Z"),
      }) === null,
    );
    const consumedHashes = new Set<string>();
    actionGrantDeps.consumeExtensionActionGrantUse = (async (input: {
      grantHash: string;
    }) => {
      if (consumedHashes.has(input.grantHash)) return "replayed";
      consumedHashes.add(input.grantHash);
      return "consumed";
    }) as any;
    const actionMismatch = await consumeExtensionActionGrant(
      actionGrant.grant,
      {
        provider: "tekmetric",
        action: "tekmetric:delete:/api/shop/id/job",
        now: new Date("2026-08-21T12:00:30Z"),
      },
    );
    const providerMismatch = await consumeExtensionActionGrant(
      actionGrant.grant,
      {
        provider: "shopware",
        action: addToRoAction,
        now: new Date("2026-08-21T12:00:30Z"),
      },
    );
    const expiredConsumption = await consumeExtensionActionGrant(
      actionGrant.grant,
      {
        provider: "tekmetric",
        action: addToRoAction,
        now: new Date("2026-08-21T12:02:01Z"),
      },
    );
    ok(
      "mismatched and expired grants are rejected before consumption",
      actionMismatch.status === "invalid" &&
        providerMismatch.status === "invalid" &&
        expiredConsumption.status === "invalid" &&
        consumedHashes.size === 0,
    );
    const firstConsumption = await consumeExtensionActionGrant(
      actionGrant.grant,
      {
        provider: "tekmetric",
        action: addToRoAction,
        now: new Date("2026-08-21T12:00:30Z"),
      },
    );
    const replayConsumption = await consumeExtensionActionGrant(
      actionGrant.grant,
      {
        provider: "tekmetric",
        action: addToRoAction,
        now: new Date("2026-08-21T12:00:31Z"),
      },
    );
    ok(
      "action grant is consumed exactly once",
      firstConsumption.status === "consumed" &&
        replayConsumption.status === "replayed",
    );
    const forgedGrant =
      actionGrant.grant.slice(0, -1) +
      (actionGrant.grant.endsWith("a") ? "b" : "a");
    const forgedConsumption = await consumeExtensionActionGrant(forgedGrant, {
      provider: "tekmetric",
      action: addToRoAction,
      now: new Date("2026-08-21T12:00:30Z"),
    });
    ok(
      "server rejects forged action-grant signatures before consumption",
      forgedConsumption.status === "invalid",
    );
  } finally {
    Object.assign(sessions.__deps, originalSessionDeps);
    Object.assign(auth.__deps, originalAuthDeps);
    Object.assign(actionGrantDeps, originalActionGrantDeps);
    if (originalSecret == null) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }

  if (failed) {
    console.error(`\nFAILED ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll secure-session checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(2);
});