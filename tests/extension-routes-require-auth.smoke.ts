/**
 * Task #495 smoke test: every shop-scoped extension route that was called
 * out as a P0 auth gap must return 401 when invoked with no extension
 * token. Each handler is imported directly and invoked with a NextRequest
 * that has no Authorization header and no `_token` query string — the
 * `guardExtensionShopRequest` (or inline `validateExtensionToken`) call
 * must short-circuit before any DB work or upstream call happens.
 *
 * Run: `npx tsx tests/extension-routes-require-auth.smoke.ts`
 *
 * The bodies/query strings below intentionally pass the shape-level
 * pre-validation each route does (VIN length, presence of arrays, roId,
 * etc.) so the response we observe is *purely* the auth path — not a 400
 * from a missing field. If a regression accidentally swaps the auth check
 * for an earlier `return` (e.g. a no-op success) this test catches it.
 */

import { NextRequest } from "next/server";

import { POST as buildRoFromVhiPOST } from "../app/api/extension/build-ro-from-vhi/route";
import { POST as prefillDviPOST } from "../app/api/extension/prefill-dvi/route";
import { POST as vhiCoachPOST } from "../app/api/extension/vhi-coach/route";
import { GET as roContextGET } from "../app/api/extension/ro-context/route";
import { POST as enhanceFindingsPOST } from "../app/api/extension/enhance-findings/route";
import {
  POST as enhanceCorrectionsPOST,
  GET as enhanceCorrectionsGET,
} from "../app/api/extension/enhance-corrections/route";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function jsonPost(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expect401(name: string, resPromise: Promise<Response>) {
  let res: Response;
  try {
    res = await resPromise;
  } catch (err: any) {
    ok(name, false, `handler threw: ${err?.message}`);
    return;
  }
  ok(name, res.status === 401, `got ${res.status}`);
  // Auth-failure body must not leak handler state (no `success: true`,
  // no domain data) — only the standardized `{ error }` shape.
  try {
    const body = await res.clone().json();
    ok(
      `  → ${name} body has only error field`,
      body && typeof body.error === "string" && body.success !== true,
      `body=${JSON.stringify(body).slice(0, 160)}`,
    );
  } catch {
    // empty body is acceptable; the 401 status is the contract
  }
}

async function run() {
  console.log("extension routes require auth (Task #495)");

  const VIN = "1HGBH41JXMN109186"; // syntactically valid 17-char VIN

  await expect401(
    "build-ro-from-vhi POST → 401 with no token",
    buildRoFromVhiPOST(
      jsonPost("http://localhost/api/extension/build-ro-from-vhi", {
        vin: VIN,
        smsShopId: "99",
        mileage: 50000,
      }),
    ),
  );

  await expect401(
    "prefill-dvi POST → 401 with no token",
    prefillDviPOST(
      jsonPost("http://localhost/api/extension/prefill-dvi", {
        vin: VIN,
        smsShopId: "99",
        mileage: 50000,
        inspectionTasks: [{ id: 1, name: "Oil Change" }],
      }),
    ),
  );

  await expect401(
    "vhi-coach POST → 401 with no token",
    vhiCoachPOST(
      jsonPost("http://localhost/api/extension/vhi-coach", {
        vin: VIN,
        smsShopId: "99",
        mileage: 50000,
        inspectionTasks: ["Oil Change"],
      }),
    ),
  );

  await expect401(
    "ro-context GET → 401 with no token",
    roContextGET(
      new NextRequest(
        "http://localhost/api/extension/ro-context?shopId=99&roId=123",
      ),
    ),
  );

  await expect401(
    "enhance-findings POST → 401 with no token",
    enhanceFindingsPOST(
      jsonPost("http://localhost/api/extension/enhance-findings", {
        shopId: "99",
        findings: [{ taskId: 1, taskName: "Brake", finding: "worn pads" }],
      }),
    ),
  );

  await expect401(
    "enhance-corrections POST → 401 with no token",
    enhanceCorrectionsPOST(
      jsonPost("http://localhost/api/extension/enhance-corrections", {
        shopId: "99",
        corrections: [
          { taskName: "Brake", aiSuggested: "a", advisorWrote: "b" },
        ],
      }),
    ),
  );

  await expect401(
    "enhance-corrections GET → 401 with no token",
    enhanceCorrectionsGET(
      new NextRequest(
        "http://localhost/api/extension/enhance-corrections?shopId=99",
      ),
    ),
  );

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
