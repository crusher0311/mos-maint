/**
 * Task #1164 — bootstrap outcome mapping for shops that can't use bootstrap.
 *
 * A shop-lookup miss or a shop outside the bootstrap allowlist must map to a
 * distinct `unavailable` outcome (200, ok:false) that the sidepanel renders as
 * a plain "please sign in" prompt — NOT to `verification_needed` (401), whose
 * alarming "could not verify this provider session" copy was shown for every
 * brand-new shop after the rollout.
 *
 * Run: npx tsx tests/extension-bootstrap-unavailable.smoke.ts
 */
import { NextRequest } from "next/server";
import { __deps, POST } from "../app/api/extension/bootstrap/route";
import { __deps as proofDeps, verifyProviderSessionProof } from "../lib/extension-provider-proof";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function request() {
  return new NextRequest("http://localhost/api/extension/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "tekmetric",
      smsShopId: "1517",
      proof: {
        kind: "tekmetric_x_auth",
        token: "provider-token-1234567890abcdef",
        origin: "https://shop.tekmetric.com",
      },
    }),
  });
}

async function run() {
  console.log("extension bootstrap: unavailable-shop outcome mapping");

  __deps.rateLimit = async () =>
    ({ allowed: true, remaining: 11, limit: 12, resetAt: new Date(), bucketKey: "f" }) as any;

  // ----- proof layer: shop lookup miss → status "unavailable" -----
  proofDeps.rateLimit = (async () => ({ allowed: true })) as any;
  proofDeps.findShopBySmsId = (async () => null) as any;
  const missProof = await verifyProviderSessionProof({
    provider: "tekmetric",
    smsShopId: "1517",
    proof: {
      kind: "tekmetric_x_auth",
      token: "provider-token-1234567890abcdef",
      origin: "https://shop.tekmetric.com",
    },
  });
  ok(
    "shop-lookup miss yields status=unavailable, not invalid",
    missProof.status === "unavailable",
    JSON.stringify(missProof),
  );

  // ----- proof layer: shop resolves but is not allowlisted -----
  delete process.env.EXTENSION_BOOTSTRAP_DISABLED;
  process.env.EXTENSION_BOOTSTRAP_TEKMETRIC_ENABLED = "true";
  process.env.EXTENSION_BOOTSTRAP_SHOPS = "1,2,3"; // shop 376 not listed
  proofDeps.findShopBySmsId = (async () => ({
    mosShopId: 376,
    provider: "tekmetric",
    shopDoc: { name: "Martin's Tire & Service" },
  })) as any;
  const notAllowlisted = await verifyProviderSessionProof({
    provider: "tekmetric",
    smsShopId: "1517",
    proof: {
      kind: "tekmetric_x_auth",
      token: "provider-token-1234567890abcdef",
      origin: "https://shop.tekmetric.com",
    },
  });
  ok(
    "non-allowlisted shop yields status=unavailable",
    notAllowlisted.status === "unavailable",
    JSON.stringify(notAllowlisted),
  );
  delete process.env.EXTENSION_BOOTSTRAP_SHOPS;
  delete process.env.EXTENSION_BOOTSTRAP_TEKMETRIC_ENABLED;

  // ----- route layer: unavailable → 200 ok:false outcome=unavailable -----
  __deps.verifyProviderSessionProof = async () =>
    ({ status: "unavailable", provider: "tekmetric", reason: "Bootstrap is unavailable for this shop" }) as any;
  let res = await POST(request());
  let body: any = await res.json();
  ok(
    "route maps unavailable to 200 / outcome=unavailable",
    res.status === 200 && body.ok === false && body.outcome === "unavailable",
    `status=${res.status} body=${JSON.stringify(body)}`,
  );

  // ----- route layer: genuine proof failures still map to verification_needed -----
  __deps.verifyProviderSessionProof = async () =>
    ({ status: "invalid", provider: "tekmetric", reason: "bad proof" }) as any;
  res = await POST(request());
  body = await res.json();
  ok(
    "invalid proof still maps to 401 / verification_needed",
    res.status === 401 && body.outcome === "verification_needed",
    `status=${res.status} body=${JSON.stringify(body)}`,
  );

  __deps.verifyProviderSessionProof = async () =>
    ({ status: "unsupported", provider: "autoflow", reason: "no proof mechanism" }) as any;
  res = await POST(request());
  body = await res.json();
  ok(
    "unsupported provider still maps to 200 / unsupported",
    res.status === 200 && body.outcome === "unsupported",
    `status=${res.status} body=${JSON.stringify(body)}`,
  );

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
