/**
 * Contract smoke tests for passwordless provider proof adapters.
 *
 * Run: npx tsx tests/extension-provider-proof.smoke.ts
 */
import {
  __deps,
  verifyProviderSessionProof,
} from "../lib/extension-provider-proof";

let failed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const original = { ...__deps };
const oldEnv = {
  enabled: process.env.EXTENSION_BOOTSTRAP_TEKMETRIC_ENABLED,
  shopmonkeyEnabled: process.env.EXTENSION_BOOTSTRAP_SHOPMONKEY_ENABLED,
  shops: process.env.EXTENSION_BOOTSTRAP_SHOPS,
  disabled: process.env.EXTENSION_BOOTSTRAP_DISABLED,
};

async function run() {
  console.log("extension provider proof");
  process.env.EXTENSION_BOOTSTRAP_TEKMETRIC_ENABLED = "true";
  process.env.EXTENSION_BOOTSTRAP_SHOPS = "85";
  delete process.env.EXTENSION_BOOTSTRAP_DISABLED;

  __deps.findShopBySmsId = async () =>
    ({
      mosShopId: 85,
      provider: "tekmetric",
      shopDoc: { shopId: 85, name: "Fixture Auto" },
    }) as any;
  __deps.now = () => Date.parse("2026-08-21T12:00:00.000Z");
  let replayAllowed = true;
  __deps.rateLimit = async () =>
    ({
      allowed: replayAllowed,
      remaining: replayAllowed ? 0 : 0,
      limit: 1,
      resetAt: new Date(),
      bucketKey: "fixture",
    }) as any;
  const called: string[] = [];
  __deps.fetch = async (url: string | URL | Request) => {
    called.push(String(url));
    if (String(url).endsWith("/api/profile")) {
      return new Response(
        JSON.stringify({
          data: {
            employeeId: 701,
            email: "ADVISOR@EXAMPLE.COM",
            emailVerified: true,
            role: "owner", // Provider role must never be used by the exchange.
          },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        OWNED: [],
        EMPLOYEE: [{ id: 1234, name: "Fixture Auto" }],
      }),
      { status: 200 },
    );
  };

  const valid = await verifyProviderSessionProof({
    provider: "tekmetric",
    smsShopId: "1234",
    proof: {
      kind: "tekmetric_x_auth",
      token: "current-browser-token-123456",
      origin: "https://shop.tekmetric.com",
    },
  });
  ok("uses the current profile endpoint", called.includes("https://shop.tekmetric.com/api/profile"));
  ok(
    "uses the employee-scoped shop endpoint",
    called.includes("https://shop.tekmetric.com/api/shops/by-employee"),
  );
  ok("accepts a live session tied to the claimed shop", valid.status === "verified");
  if (valid.status === "verified") {
    ok("returns the canonical MOS shop", valid.shopId === 85);
    ok("normalizes the provider subject", valid.employee?.subject === "701");
    ok(
      "accepts only explicitly verified profile email",
      valid.employee?.verifiedEmail === "advisor@example.com",
    );
    ok("gives the proof a short freshness window", valid.expiresAt.getTime() - valid.verifiedAt.getTime() === 90_000);
  }

  __deps.fetch = async (url: string | URL | Request) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("/api/profile")
          ? {
              id: "employee-with-unverified-email",
              email: "unverified@example.com",
              emailVerified: false,
            }
          : { EMPLOYEE: [{ id: 1234, name: "Fixture Auto" }] },
      ),
      { status: 200 },
    );
  const unverifiedEmail = await verifyProviderSessionProof({
    provider: "tekmetric",
    smsShopId: "1234",
    proof: {
      kind: "tekmetric_x_auth",
      token: "unverified-email-token-12345",
      origin: "https://shop.tekmetric.com",
    },
  });
  ok(
    "never upgrades an authenticated but unverified provider email",
    unverifiedEmail.status === "verified" &&
      unverifiedEmail.employee?.subject === "employee-with-unverified-email" &&
      unverifiedEmail.employee?.verifiedEmail == null,
  );

  replayAllowed = false;
  const replay = await verifyProviderSessionProof({
    provider: "tekmetric",
    smsShopId: "1234",
    proof: {
      kind: "tekmetric_x_auth",
      token: "current-browser-token-123456",
      origin: "https://shop.tekmetric.com",
    },
  });
  ok("rejects a distributed replay claim", replay.status === "replayed");

  // Duplicate simultaneous bootstraps: the twin exchange within the grace
  // budget must succeed instead of surfacing a replayed error.
  replayAllowed = true;
  __deps.rateLimit = async () =>
    ({
      allowed: true,
      remaining: 1, // limit 3, count 2 → the second exchange of the same proof
      limit: 3,
      resetAt: new Date(),
      bucketKey: "fixture",
    }) as any;
  const duplicate = await verifyProviderSessionProof({
    provider: "tekmetric",
    smsShopId: "1234",
    proof: {
      kind: "tekmetric_x_auth",
      token: "current-browser-token-123456",
      origin: "https://shop.tekmetric.com",
    },
  });
  ok(
    "a duplicate exchange within the grace budget still verifies",
    duplicate.status === "verified",
  );
  __deps.rateLimit = async () =>
    ({
      allowed: replayAllowed,
      remaining: replayAllowed ? 0 : 0,
      limit: 1,
      resetAt: new Date(),
      bucketKey: "fixture",
    }) as any;

  replayAllowed = true;
  __deps.fetch = async (url: string | URL | Request) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("/api/profile")
          ? { id: "employee-1", email: "advisor@example.com", emailVerified: true }
          : { EMPLOYEE: [{ id: 9999, name: "Other Shop" }] },
      ),
      { status: 200 },
    );
  const wrongShop = await verifyProviderSessionProof({
    provider: "tekmetric",
    smsShopId: "1234",
    proof: {
      kind: "tekmetric_x_auth",
      token: "other-current-token-1234567",
      origin: "https://shop.tekmetric.com",
    },
  });
  ok("rejects a provider session not assigned to the claimed shop", wrongShop.status === "invalid");

  __deps.fetch = async () => new Response("{}", { status: 401 });
  const expired = await verifyProviderSessionProof({
    provider: "tekmetric",
    smsShopId: "1234",
    proof: {
      kind: "tekmetric_x_auth",
      token: "expired-browser-token-12345",
      origin: "https://shop.tekmetric.com",
    },
  });
  ok("classifies an expired browser session", expired.status === "expired");

  // ---------------- Shopmonkey ----------------
  process.env.EXTENSION_BOOTSTRAP_SHOPMONKEY_ENABLED = "true";
  __deps.findShopBySmsId = async () =>
    ({
      mosShopId: 85,
      provider: "shopmonkey",
      shopDoc: { shopId: 85, name: "Monkey Motors" },
    }) as any;
  const smCalled: string[] = [];
  let smAuthHeader: string | null = null;
  __deps.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    smCalled.push(String(url));
    smAuthHeader = String((init?.headers as any)?.Authorization ?? "");
    if (String(url).endsWith("/v3/user/logged-in")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: "64b000000000000000000701",
            email: "SM-ADVISOR@example.com",
            companyId: "64b0000000000000000000c1",
            currentLocationId: "64b0000000000000000000l1",
          },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        success: true,
        data: [
          { id: "64b0000000000000000000l1", companyId: "64b0000000000000000000c1" },
        ],
      }),
      { status: 200 },
    );
  };
  const smValid = await verifyProviderSessionProof({
    provider: "shopmonkey",
    smsShopId: "64b0000000000000000000l1",
    proof: {
      kind: "shopmonkey_bearer",
      token: "sm-browser-bearer-token-123456",
      origin: "https://api.shopmonkey.cloud",
    },
  });
  ok(
    "shopmonkey: probes the documented current-user endpoint on the pinned API host",
    smCalled.includes("https://api.shopmonkey.cloud/v3/user/logged-in"),
  );
  ok(
    "shopmonkey: probes the session's location list for membership",
    smCalled.includes("https://api.shopmonkey.cloud/v3/location"),
  );
  ok(
    "shopmonkey: sends only the browser bearer, never a stored API key",
    smAuthHeader === "Bearer sm-browser-bearer-token-123456",
  );
  ok("shopmonkey: accepts a live session tied to the claimed shop", smValid.status === "verified");
  if (smValid.status === "verified") {
    ok("shopmonkey: returns the canonical MOS shop", smValid.shopId === 85);
    ok(
      "shopmonkey: normalizes the provider subject",
      smValid.employee?.subject === "64b000000000000000000701",
    );
    ok(
      "shopmonkey: normalizes the verified email",
      smValid.employee?.verifiedEmail === "sm-advisor@example.com",
    );
  }

  const smWrongShop = await verifyProviderSessionProof({
    provider: "shopmonkey",
    smsShopId: "64bffffffffffffffffffff0",
    proof: {
      kind: "shopmonkey_bearer",
      token: "sm-browser-bearer-token-777777",
      origin: "https://api.shopmonkey.cloud",
    },
  });
  ok(
    "shopmonkey: rejects a session not assigned to the claimed location/company",
    smWrongShop.status === "invalid",
  );

  __deps.fetch = async () => new Response("{}", { status: 401 });
  const smExpired = await verifyProviderSessionProof({
    provider: "shopmonkey",
    smsShopId: "64b0000000000000000000l1",
    proof: {
      kind: "shopmonkey_bearer",
      token: "sm-expired-bearer-token-000000",
      origin: "https://api.shopmonkey.cloud",
    },
  });
  ok("shopmonkey: classifies an expired browser session", smExpired.status === "expired");

  let smMissingProofFetched = false;
  __deps.fetch = async () => {
    smMissingProofFetched = true;
    return new Response();
  };
  const smNoProof = await verifyProviderSessionProof({
    provider: "shopmonkey",
    smsShopId: "64b0000000000000000000l1",
  });
  ok(
    "shopmonkey: fails closed without a captured browser bearer",
    smNoProof.status === "invalid" && !smMissingProofFetched,
  );

  process.env.EXTENSION_BOOTSTRAP_SHOPMONKEY_ENABLED = "false";
  const smFlaggedOff = await verifyProviderSessionProof({
    provider: "shopmonkey",
    smsShopId: "64b0000000000000000000l1",
    proof: {
      kind: "shopmonkey_bearer",
      token: "sm-browser-bearer-token-123456",
      origin: "https://api.shopmonkey.cloud",
    },
  });
  ok(
    "shopmonkey: rollout flag off is a calm unavailable outcome",
    smFlaggedOff.status === "unavailable",
  );
  process.env.EXTENSION_BOOTSTRAP_SHOPMONKEY_ENABLED = "true";

  // Restore tekmetric-shaped lookup for the remaining tekmetric scenarios.
  __deps.findShopBySmsId = async () =>
    ({
      mosShopId: 85,
      provider: "tekmetric",
      shopDoc: { shopId: 85, name: "Fixture Auto" },
    }) as any;

  let autoflowFetched = false;
  __deps.fetch = async () => {
    autoflowFetched = true;
    return new Response();
  };
  const autoflowUnsupported = await verifyProviderSessionProof({
    provider: "autoflow",
    smsShopId: "harrells-nc87",
  });
  ok(
    "autoflow keeps the calm unsupported outcome (no confirmed identity endpoint)",
    autoflowUnsupported.status === "unsupported" && !autoflowFetched,
  );
  // Even when the extension supplies a bearer-shaped proof (v4 localStorage
  // token), AutoFlow must stay unsupported and NEVER live-probe: discovery
  // found no provider endpoint that attests the operator's identity, and the
  // cookie-only v3 path forbids wholesale cookie forwarding. See
  // docs/autoflow-bootstrap-proof-findings.md.
  autoflowFetched = false;
  const autoflowWithProof = await verifyProviderSessionProof({
    provider: "autoflow",
    smsShopId: "harrells-nc87",
    proof: {
      kind: "autoflow_bearer",
      token: "af-localstorage-bearer-token-123456",
      origin: "https://app.autoflow.com",
    },
  });
  ok(
    "autoflow ignores a supplied bearer proof and never probes the provider",
    autoflowWithProof.status === "unsupported" && !autoflowFetched,
  );

  let unsupportedFetched = false;
  __deps.fetch = async () => {
    unsupportedFetched = true;
    return new Response();
  };
  const unsupported = await verifyProviderSessionProof({
    provider: "shopware",
    smsShopId: "tenant",
  });
  ok("fails unsupported providers closed", unsupported.status === "unsupported");
  ok("never forwards unsupported-provider cookies or credentials", !unsupportedFetched);

  process.env.EXTENSION_BOOTSTRAP_DISABLED = "true";
  const killed = await verifyProviderSessionProof({
    provider: "tekmetric",
    smsShopId: "1234",
    proof: {
      kind: "tekmetric_x_auth",
      token: "valid-but-killed-token-1234",
      origin: "https://shop.tekmetric.com",
    },
  });
  // Task #1164: feature-off (kill switch / allowlist / lookup miss) is a calm
  // `unavailable` outcome (plain sign-in prompt), not a verification failure.
  ok("honors the global rollout kill switch", killed.status === "unavailable");
}

run()
  .catch((error) => {
    failed += 1;
    console.error(error);
  })
  .finally(() => {
    Object.assign(__deps, original);
    if (oldEnv.enabled == null) delete process.env.EXTENSION_BOOTSTRAP_TEKMETRIC_ENABLED;
    else process.env.EXTENSION_BOOTSTRAP_TEKMETRIC_ENABLED = oldEnv.enabled;
    if (oldEnv.shopmonkeyEnabled == null) delete process.env.EXTENSION_BOOTSTRAP_SHOPMONKEY_ENABLED;
    else process.env.EXTENSION_BOOTSTRAP_SHOPMONKEY_ENABLED = oldEnv.shopmonkeyEnabled;
    if (oldEnv.shops == null) delete process.env.EXTENSION_BOOTSTRAP_SHOPS;
    else process.env.EXTENSION_BOOTSTRAP_SHOPS = oldEnv.shops;
    if (oldEnv.disabled == null) delete process.env.EXTENSION_BOOTSTRAP_DISABLED;
    else process.env.EXTENSION_BOOTSTRAP_DISABLED = oldEnv.disabled;
    if (failed > 0) process.exit(1);
    console.log("extension provider proof: PASS");
  });