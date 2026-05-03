/**
 * Smoke test for HoverCode create-payload contract.
 *
 * Run: `npx tsx tests/hovercode-create-payload.smoke.ts`
 *
 * The 200-with-no-logo prod bug had two halves: the create call must SEND
 * `logo_url`, and the read-back must FAIL when the API silently drops it.
 * `tests/hovercode-drift.smoke.ts` already pins the read-back half. This
 * test pins the send half — a regression that omitted `logo_url` from the
 * POST body would silently ship logo-less stickers, even if the read-back
 * guard later flagged them.
 *
 * It mocks `globalThis.fetch`, calls `createHovercodeQR`, and asserts the
 * outgoing request body for both:
 *   - Caller-supplied `logoUrl` is forwarded as `logo_url`.
 *   - Default fallback `appointment-logo.png` is sent when no logoUrl given.
 */

import { createHovercodeQR } from "../lib/hovercode";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

process.env.HOVERCODE_API_TOKEN = "test-token";
process.env.HOVERCODE_WORKSPACE_ID = "ws-test";
process.env.NEXT_PUBLIC_BASE_URL = "https://mos.tools";

function captureFetch() {
  const calls: { url: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const urlStr = String(url);
    let body: any = null;
    try { body = init?.body ? JSON.parse(init.body) : null; } catch { body = init?.body; }
    calls.push({ url: urlStr, body });
    if (urlStr.includes("/hovercode/create/")) {
      return new Response(JSON.stringify({ id: "hc_test_1", shortlink_url: "https://hvr.cd/abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Read-back GETs from the fire-and-forget verifyHovercode — return a
    // benign 200 with the same logo_url so it doesn't drift.
    return new Response(
      JSON.stringify({
        id: "hc_test_1",
        qr_data: body?.qr_data || "https://mos.tools/sticker/redirect/100",
        logo_url: "any",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function run() {
  console.log("hovercode-create-payload smoke");

  // 1. Caller-supplied logoUrl is forwarded as logo_url
  {
    const { calls, restore } = captureFetch();
    try {
      const r = await createHovercodeQR({
        shopId: 100,
        shopName: "Test Shop",
        logoUrl: "https://example.com/custom-logo.png",
      });
      ok("create returns success=true on 200", r.success === true);
      const createCall = calls.find((c) => c.url.includes("/hovercode/create/"));
      ok("POST sent to /hovercode/create/", !!createCall);
      ok(
        "logo_url present in outgoing body",
        typeof createCall?.body?.logo_url === "string" && createCall!.body.logo_url.length > 0,
      );
      ok(
        "caller-supplied logoUrl forwarded verbatim",
        createCall?.body?.logo_url === "https://example.com/custom-logo.png",
      );
      // Other contract fields the QR depends on.
      ok("qr_data set to redirect URL", createCall?.body?.qr_data === "https://mos.tools/sticker/redirect/100");
      ok("workspace id forwarded", createCall?.body?.workspace === "ws-test");
      ok("dynamic flag stays true", createCall?.body?.dynamic === true);
      ok("generate_png flag stays true", createCall?.body?.generate_png === true);
    } finally {
      restore();
    }
  }

  // 2. Default fallback logo_url is sent when no logoUrl given
  {
    const { calls, restore } = captureFetch();
    try {
      await createHovercodeQR({ shopId: 200, shopName: "Default Shop" });
      const createCall = calls.find((c) => c.url.includes("/hovercode/create/"));
      ok(
        "default fallback logo_url is sent when caller omits logoUrl",
        createCall?.body?.logo_url === "https://mos.tools/appointment-logo.png",
      );
    } finally {
      restore();
    }
  }

  // 3. Authorization header is set with Token scheme (regression guard)
  {
    const callsLog: { headers: any }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      callsLog.push({ headers: init?.headers });
      return new Response(JSON.stringify({ id: "hc_x", shortlink_url: "u" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;
    try {
      await createHovercodeQR({ shopId: 1, shopName: "x" });
      const auth = callsLog[0]?.headers?.Authorization;
      ok("Authorization header uses Token scheme", typeof auth === "string" && auth.startsWith("Token "));
    } finally {
      globalThis.fetch = original;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
