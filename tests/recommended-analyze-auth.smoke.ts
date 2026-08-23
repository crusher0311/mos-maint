/**
 * Regression tests for POST /api/recommended/analyze (task #1129).
 *
 * Verifies:
 * 1. Unauthenticated calls → 401
 * 2. Successful AI response flows through to JSON result
 * 3. Usage logging receives session.shopId (not a caller-supplied shopId)
 * 4. Budget enforcement is called with the session shop
 *
 * All real dependencies are swapped via the route's __deps test seam.
 * No real DB, OpenAI, or auth calls are made.
 *
 * Run:
 *   NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
 *     npx tsx tests/recommended-analyze-auth.smoke.ts
 */

import {
  POST,
  __deps,
} from "../app/api/recommended/analyze/route";
import { ObjectId } from "mongodb";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHOP_A = 42;

function makeReq(body: any) {
  return new Request("http://localhost/api/recommended/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const AI_RESPONSE_JSON = JSON.stringify({
  recommendations: [
    { title: "Oil Change", why: "Due", priority: 1, sources: ["OEM"], suggestedTiming: "Now", notes: "" },
  ],
});

const ORIG = {
  getSession: __deps.getSession,
  enforceAiBudget: __deps.enforceAiBudget,
  callOpenAIFn: __deps.callOpenAIFn,
  logUsage: __deps.logUsage,
  trackApiRequest: __deps.trackApiRequest,
};

function restore() {
  Object.assign(__deps, ORIG);
}

function stubOk(loggedShopIds: number[], budgetShopIds: number[]) {
  __deps.getSession = async () => ({ shopId: SHOP_A, role: "admin" } as any);
  __deps.enforceAiBudget = async ({ shopId }: any) => {
    budgetShopIds.push(Number(shopId));
    return null; // not blocked
  };
  __deps.callOpenAIFn = async () => ({ ok: true, text: `\`\`\`json\n${AI_RESPONSE_JSON}\n\`\`\`` });
  __deps.logUsage = async ({ shopId }) => {
    loggedShopIds.push(Number(shopId));
    return { acknowledged: true, insertedId: new ObjectId() };
  };
  __deps.trackApiRequest = (async () => {}) as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log("recommended/analyze auth regression tests");

  // 1. No session → 401
  console.log("\n[1] Authentication");
  {
    __deps.getSession = (async () => null) as any;
    __deps.enforceAiBudget = ORIG.enforceAiBudget;
    const res = await POST(makeReq({ dviData: null, carfaxData: null, oemData: [] }));
    ok("no session → 401", res.status === 401, `got ${res.status}`);
  }

  // 2. Successful AI call returns parsed recommendations
  console.log("\n[2] Successful AI response");
  {
    const logged: number[] = [];
    const budgeted: number[] = [];
    stubOk(logged, budgeted);
    const res = await POST(makeReq({ dviData: { ok: false }, carfaxData: { ok: false }, oemData: [] }));
    const body = await res.json();
    ok("successful response → 200", res.status === 200, `got ${res.status}: ${JSON.stringify(body)}`);
    ok("ok:true in response", body.ok === true, JSON.stringify(body));
    ok("parsed recommendations present", Array.isArray(body.parsed?.recommendations), JSON.stringify(body.parsed));
    ok("raw text present", typeof body.raw === "string" && body.raw.length > 0);
  }

  // 3. Usage is attributed to session shop, not any caller-supplied shopId
  console.log("\n[3] Session shopId attribution");
  {
    const logged: number[] = [];
    const budgeted: number[] = [];
    stubOk(logged, budgeted);
    // Caller tries to supply a different shopId — it must be ignored
    await POST(makeReq({ shopId: 999, dviData: null, carfaxData: null, oemData: [] }));
    ok(
      "budget enforced for session shop, not caller shopId",
      budgeted.length > 0 && budgeted.every((id) => id === SHOP_A),
      `budgeted shop IDs: ${budgeted}`,
    );
    ok(
      "usage logged for session shop, not caller shopId",
      logged.length > 0 && logged.every((id) => id === SHOP_A),
      `logged shop IDs: ${logged}`,
    );
  }

  // 4. AI failure → 500
  console.log("\n[4] AI failure");
  {
    const logged: number[] = [];
    const budgeted: number[] = [];
    stubOk(logged, budgeted);
    __deps.callOpenAIFn = async () => ({ ok: false, error: "AI unavailable" });
    const res = await POST(makeReq({ dviData: null, carfaxData: null, oemData: [] }));
    const body = await res.json();
    ok("AI failure → 500", res.status === 500, `got ${res.status}`);
    ok("error message present", typeof body.error === "string");
  }

  restore();
}

run()
  .then(() => {
    if (failed > 0) {
      console.error(`\n${failed} assertion(s) failed`);
      process.exit(1);
    }
    console.log("\nAll recommended-analyze auth assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
