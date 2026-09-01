/**
 * Exchange contract for `/api/extension/bootstrap`.
 *
 * Run: npx tsx tests/extension-bootstrap-route.smoke.ts
 */
import { NextRequest } from "next/server";
import { __deps, POST } from "../app/api/extension/bootstrap/route";

let failed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const original = { ...__deps };
let issuedInput: any = null;
let revokedSession: string | null = null;

const proof = {
  status: "verified" as const,
  provider: "tekmetric" as const,
  shopId: 85,
  smsShopId: "1234",
  shopName: "Fixture Auto",
  employee: {
    subject: "employee-7",
    verifiedEmail: "advisor@example.com",
  },
  verifiedAt: new Date("2026-08-21T12:00:00.000Z"),
  expiresAt: new Date("2026-08-21T12:01:30.000Z"),
};

function request(auth = false) {
  return new NextRequest("http://localhost/api/extension/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: "Bearer exts_prior" } : {}),
    },
    body: JSON.stringify({
      provider: "tekmetric",
      smsShopId: "1234",
      proof: {
        kind: "tekmetric_x_auth",
        token: "provider-token-never-returned",
        origin: "https://shop.tekmetric.com",
      },
    }),
  });
}

function issued(assurance: "basic" | "verified", userId?: string) {
  return {
    token: assurance === "basic" ? "exts_basic" : "exts_verified",
    principal: {
      sessionId: assurance === "basic" ? "s-basic" : "s-verified",
      assurance,
      userId,
      shopId: 85,
      provider: "tekmetric",
      capabilities:
        assurance === "basic"
          ? ["read", "shop_tool"]
          : ["read", "shop_tool", "write", "provider_action"],
      expiresAt: new Date("2026-08-21T20:00:00.000Z"),
    },
  };
}

async function run() {
  console.log("extension bootstrap route");
  __deps.now = () => Date.parse("2026-08-21T12:00:00.000Z");
  __deps.rateLimit = async () =>
    ({
      allowed: true,
      remaining: 11,
      limit: 12,
      resetAt: new Date(),
      bucketKey: "fixture",
    }) as any;
  __deps.verifyProviderSessionProof = async () => proof;
  __deps.lookupExtensionSession = async () => ({ status: "invalid" } as any);
  __deps.revokeExtensionSession = async (id: string) => {
    revokedSession = id;
  };
  __deps.issueBasicExtensionSession = async (input: any) => {
    issuedInput = input;
    return issued("basic") as any;
  };
  __deps.issueExtensionSession = async (input: any) => {
    issuedInput = input;
    return issued("verified", input.userId) as any;
  };

  __deps.recordProviderIdentity = async () => {};
  __deps.listCandidateUsers = async () => [];
  let response = await POST(request());
  let body: any = await response.json();
  ok("issues Basic for valid shop proof without a unique user", response.status === 200 && body.outcome === "basic");
  ok(
    "Tekmetric Basic receives only read and safe shop tools",
    JSON.stringify(body.capabilities) === '["read","shop_tool"]',
  );
  ok("returns only the proof-bound shop", body.shops.length === 1 && body.shops[0].shopId === 85);
  ok("does not echo provider proof", !JSON.stringify(body).includes("provider-token-never-returned"));
  ok(
    "uses an eight-hour bootstrap session",
    issuedInput.expiresAt.getTime() - proof.verifiedAt.getTime() === 8 * 60 * 60 * 1000,
  );

  __deps.listCandidateUsers = async () => [
    {
      _id: "u-owner",
      email: "advisor@example.com",
      name: "Alex Advisor",
      role: "owner",
      shopId: 85,
      shopIds: [85],
    },
  ];
  __deps.lookupExtensionSession = async () =>
    ({
      status: "active",
      principal: {
        sessionId: "prior-basic",
        assurance: "basic",
        shopId: 85,
        provider: "tekmetric",
        capabilities: ["read"],
        expiresAt: new Date(Date.now() + 60_000),
      },
    }) as any;
  response = await POST(request(true));
  body = await response.json();
  ok("upgrades a unique existing user in the same exchange", body.outcome === "matched_user");
  ok("preserves the existing MOS role", body.user.role === "owner");
  ok("preserves an existing owner's write authority", issuedInput.canWrite === true);
  ok("does not infer platform admin from provider/MOS owner role", issuedInput.isAdmin === false);
  ok("revokes the superseded Basic session", revokedSession === "prior-basic");

  __deps.listCandidateUsers = async () => [
    {
      _id: "u1",
      email: "advisor@example.com",
      role: "user",
      shopId: 85,
      shopIds: [85],
    },
    {
      _id: "u2",
      email: "advisor@example.com",
      role: "user",
      shopId: 85,
      shopIds: [85],
    },
  ];
  response = await POST(request());
  body = await response.json();
  ok("ambiguous identity safely falls back to Basic", body.outcome === "basic");

  __deps.verifyProviderSessionProof = async () =>
    ({
      status: "invalid",
      provider: "tekmetric",
      reason: "internal detail",
    }) as any;
  response = await POST(request());
  body = await response.json();
  ok("invalid proof fails closed", response.status === 401 && body.outcome === "verification_needed");
  ok("invalid proof does not disclose internal failure details", body.reason === "verification_needed");

  __deps.verifyProviderSessionProof = async () =>
    ({
      status: "unsupported",
      provider: "shopware",
      reason: "No independently verifiable current-session proof",
    }) as any;
  response = await POST(request());
  body = await response.json();
  ok("unsupported providers return an explicit UI-safe result", response.status === 200 && body.outcome === "unsupported");

  let verifierCalled = false;
  __deps.verifyProviderSessionProof = async () => {
    verifierCalled = true;
    return proof;
  };
  __deps.rateLimit = async ({ id }: any) =>
    ({
      allowed: !String(id).startsWith("extension-bootstrap-attempt:"),
      remaining: 0,
      limit: 4,
      resetAt: new Date(),
      bucketKey: id,
    }) as any;
  response = await POST(request());
  body = await response.json();
  ok("proof-bound throttling runs before provider probes", response.status === 429 && !verifierCalled);
  ok("proof-bound throttling returns a privacy-safe outcome", body.outcome === "rate_limited");
}

run()
  .catch((error) => {
    failed += 1;
    console.error(error);
  })
  .finally(() => {
    Object.assign(__deps, original);
    if (failed > 0) process.exit(1);
    console.log("extension bootstrap route: PASS");
  });