/**
 * Smoke test for the Stripe webhook signature verification path.
 *
 * The Stripe webhook delegates HMAC verification to the Stripe SDK
 * (`stripe.webhooks.constructEvent`), but the route owns the surrounding
 * contract that protects us during the DB cutover:
 *
 *   1. A POST with NO `stripe-signature` header is rejected with 400 BEFORE
 *      Mongo is touched. (Required so attackers can't probe the route or
 *      DoS our DB connection pool with empty bodies.)
 *   2. A POST with a stripe-signature but no matching webhook secret /
 *      bogus signature is rejected with 400 (the SDK throws → we 400).
 *
 * Idempotency is enforced via the `stripe_webhook_events` collection — that
 * path does require Mongo and is not covered here. The signature gate
 * tested below runs first, so a green check here means malformed traffic
 * never reaches the idempotency layer in the first place.
 *
 * Run: `npx tsx tests/stripe-webhook-signature.smoke.ts`
 */

import { NextRequest } from "next/server";
import { POST } from "../app/api/stripe/webhook/route";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeReq(headers: Record<string, string>, body: string): NextRequest {
  return new NextRequest("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers,
    body,
  } as any);
}

async function run() {
  console.log("stripe-webhook-signature smoke");

  // (1) Missing stripe-signature header → 400, no DB touch.
  {
    const res = await POST(makeReq({ "content-type": "application/json" }, "{}"));
    ok("missing stripe-signature → 400", res.status === 400, `got ${res.status}`);
    const body = await res.json().catch(() => ({}));
    ok("  → response body has error field", typeof body?.error === "string");
  }

  // (2) Bogus signature with secret set → 400 (Stripe SDK throws → handler catches).
  // We force the secret on so we go through the constructEvent path. This must
  // not 500 — a 500 would indicate the catch was missing. Restore env after.
  {
    const ORIG = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_garbage";
    try {
      const res = await POST(makeReq(
        { "content-type": "application/json", "stripe-signature": "t=123,v1=deadbeef" },
        JSON.stringify({ id: "evt_x", type: "ping" }),
      ));
      ok("bogus signature with secret → 400 (not 500)", res.status === 400, `got ${res.status}`);
    } finally {
      if (ORIG === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = ORIG;
    }
  }

  if (failed > 0) {
    console.error(`\nFAILED ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(2);
});
