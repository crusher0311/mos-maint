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
    if (oldEnv.shops == null) delete process.env.EXTENSION_BOOTSTRAP_SHOPS;
    else process.env.EXTENSION_BOOTSTRAP_SHOPS = oldEnv.shops;
    if (oldEnv.disabled == null) delete process.env.EXTENSION_BOOTSTRAP_DISABLED;
    else process.env.EXTENSION_BOOTSTRAP_DISABLED = oldEnv.disabled;
    if (failed > 0) process.exit(1);
    console.log("extension provider proof: PASS");
  });