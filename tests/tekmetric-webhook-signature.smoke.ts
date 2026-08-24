/**
 * Smoke test for the Tekmetric webhook HMAC signature verification path.
 *
 * Verifies the contract documented in `app/api/webhooks/tekmetric/route.ts`:
 *
 *   1. With NO `TEKMETRIC_WEBHOOK_SIGNING_SECRET` set, signature checks are
 *      disabled (any request passes). This is the deliberate "introspection
 *      mode" the route ships with — see Step 3b in the route comment.
 *   2. With the secret set, a request with NO signature header is rejected.
 *   3. With the secret set, a request with a WRONG signature is rejected.
 *   4. With the secret set, a request with a correctly-computed
 *      `sha256=<hex-hmac>` signature is accepted.
 *   5. The "sha256=" prefix is stripped before comparison (Tekmetric format).
 *
 * Uses the `__verifySignature` test seam exposed by the route to exercise
 * the pure verification logic without hitting Mongo / forwarding / etc.
 *
 * Run: `npx tsx tests/tekmetric-webhook-signature.smoke.ts`
 */

import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { verifySignature as __verifySignature } from "../app/api/webhooks/tekmetric/verify-signature";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/webhooks/tekmetric", {
    method: "POST",
    headers,
  } as any);
}

async function run() {
  console.log("tekmetric-webhook-signature smoke");

  const ORIG_SECRET = process.env.TEKMETRIC_WEBHOOK_SIGNING_SECRET;
  const ORIG_HEADER = process.env.TEKMETRIC_WEBHOOK_SIGNATURE_HEADER;
  const ORIG_ALGO = process.env.TEKMETRIC_WEBHOOK_SIGNATURE_ALGO;
  const ORIG_ENC = process.env.TEKMETRIC_WEBHOOK_SIGNATURE_ENCODING;

  try {
    const body = JSON.stringify({ event: "RepairOrder.Posted", data: { id: 1 } });

    // (1) Verification disabled when secret is unset
    {
      delete process.env.TEKMETRIC_WEBHOOK_SIGNING_SECRET;
      const res = __verifySignature(body, makeReq({}));
      ok("no secret → verification skipped (introspection mode)", res === null,
        `got ${JSON.stringify(res)}`);
    }

    // (2-5) With secret enabled
    process.env.TEKMETRIC_WEBHOOK_SIGNING_SECRET = "test-secret";
    delete process.env.TEKMETRIC_WEBHOOK_SIGNATURE_HEADER;
    delete process.env.TEKMETRIC_WEBHOOK_SIGNATURE_ALGO;
    delete process.env.TEKMETRIC_WEBHOOK_SIGNATURE_ENCODING;

    // (2) Missing header
    {
      const res = __verifySignature(body, makeReq({}));
      ok("missing signature header → rejected",
        typeof res === "string" && res.includes("missing signature header"), `got ${res}`);
    }

    // (3) Wrong signature
    {
      const res = __verifySignature(body, makeReq({
        "x-tekmetric-signature": "deadbeef".repeat(8),
      }));
      ok("wrong signature → rejected",
        typeof res === "string" && res.toLowerCase().includes("mismatch"), `got ${res}`);
    }

    // (4) Correct hex HMAC-SHA256, no prefix
    {
      const expected = crypto.createHmac("sha256", "test-secret").update(body).digest("hex");
      const res = __verifySignature(body, makeReq({
        "x-tekmetric-signature": expected,
      }));
      ok("correct hex signature → accepted", res === null, `got ${res}`);
    }

    // (5) Correct hex HMAC-SHA256, with "sha256=" prefix (Tekmetric / GitHub style)
    {
      const expected = crypto.createHmac("sha256", "test-secret").update(body).digest("hex");
      const res = __verifySignature(body, makeReq({
        "x-tekmetric-signature": `sha256=${expected}`,
      }));
      ok("correct sha256=<hex> signature → accepted (prefix stripped)", res === null, `got ${res}`);
    }

    // (6) Body tampering invalidates the signature (replay protection)
    {
      const expected = crypto.createHmac("sha256", "test-secret").update(body).digest("hex");
      const tampered = body.replace(`"id":1`, `"id":2`);
      const res = __verifySignature(tampered, makeReq({
        "x-tekmetric-signature": expected,
      }));
      ok("tampered body → rejected",
        typeof res === "string" && res.toLowerCase().includes("mismatch"), `got ${res}`);
    }
  } finally {
    if (ORIG_SECRET === undefined) delete process.env.TEKMETRIC_WEBHOOK_SIGNING_SECRET;
    else process.env.TEKMETRIC_WEBHOOK_SIGNING_SECRET = ORIG_SECRET;
    if (ORIG_HEADER === undefined) delete process.env.TEKMETRIC_WEBHOOK_SIGNATURE_HEADER;
    else process.env.TEKMETRIC_WEBHOOK_SIGNATURE_HEADER = ORIG_HEADER;
    if (ORIG_ALGO === undefined) delete process.env.TEKMETRIC_WEBHOOK_SIGNATURE_ALGO;
    else process.env.TEKMETRIC_WEBHOOK_SIGNATURE_ALGO = ORIG_ALGO;
    if (ORIG_ENC === undefined) delete process.env.TEKMETRIC_WEBHOOK_SIGNATURE_ENCODING;
    else process.env.TEKMETRIC_WEBHOOK_SIGNATURE_ENCODING = ORIG_ENC;
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
