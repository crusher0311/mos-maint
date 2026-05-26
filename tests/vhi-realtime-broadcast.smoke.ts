/**
 * Task #484: smoke test for the VHI realtime broadcaster.
 *
 * Pins:
 *   - `broadcastVhiUpdated` no-ops when `VHI_REALTIME_PUSH_ENABLED` is
 *     unset, even with full Supabase env present. This is what keeps
 *     prod safe today — the feature must be opt-in.
 *   - Returns "disabled" when env flag is missing / config missing.
 *   - When enabled, posts to `${SUPABASE_URL}/realtime/v1/api/broadcast`
 *     with the service role key in both `apikey` and `Authorization`
 *     headers and a topic of `vhi:{shopId}:{vin}`.
 *   - Per-(shop,vin) debounce: a second call within 750ms returns
 *     "debounced" and does NOT hit fetch.
 *   - Different (shop,vin) tuples are NOT debounced together.
 *   - Failures (network throw, non-2xx) return "failed" and never throw.
 *
 * Run: `npx tsx tests/vhi-realtime-broadcast.smoke.ts`
 */

import {
  broadcastVhiUpdated,
  isVhiRealtimeEnabled,
  _resetVhiBroadcastStateForTests,
} from "../lib/realtime/broadcast-vhi";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `\n      expected: ${e}\n      actual:   ${a}`);
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function makeFetchStub(response: { ok: boolean; status?: number; text?: string }) {
  const calls: CapturedCall[] = [];
  const stub: typeof fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init: init || {} });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      text: async () => response.text ?? "",
    } as any;
  }) as any;
  return { stub, calls };
}

async function run() {
  console.log("VHI realtime broadcast smoke test");

  // ---------- env-flag gating ----------
  delete process.env.VHI_REALTIME_PUSH_ENABLED;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  _resetVhiBroadcastStateForTests();

  ok("isVhiRealtimeEnabled() false when flag unset", !isVhiRealtimeEnabled());
  {
    const { stub, calls } = makeFetchStub({ ok: true });
    const r = await broadcastVhiUpdated({
      vin: "1HGCM82633A123456",
      shopId: 42,
      reason: "plan_cache_invalidate",
      fetchImpl: stub,
    });
    eq("disabled when flag unset", r, "disabled");
    eq("no fetch attempted when disabled", calls.length, 0);
  }

  // ---------- enabled + happy path ----------
  process.env.VHI_REALTIME_PUSH_ENABLED = "true";
  _resetVhiBroadcastStateForTests();
  ok("isVhiRealtimeEnabled() true when flag set", isVhiRealtimeEnabled());

  {
    const { stub, calls } = makeFetchStub({ ok: true });
    const r = await broadcastVhiUpdated({
      vin: "1hgcm82633a123456",
      shopId: 42,
      reason: "plan_cache_invalidate",
      now: () => 1_700_000_000_000,
      fetchImpl: stub,
    });
    eq("sent on happy path", r, "sent");
    eq("one POST issued", calls.length, 1);
    eq(
      "URL is the broadcast endpoint",
      calls[0].url,
      "https://example.supabase.co/realtime/v1/api/broadcast"
    );
    const headers = (calls[0].init.headers || {}) as Record<string, string>;
    eq("apikey header set", headers["apikey"], "test-service-key");
    eq("Authorization header set", headers["Authorization"], "Bearer test-service-key");
    const body = JSON.parse(String(calls[0].init.body));
    ok("body has one message", Array.isArray(body.messages) && body.messages.length === 1);
    const msg = body.messages[0];
    eq("topic includes shop+vin", msg.topic, "vhi:42:1HGCM82633A123456");
    eq("event is vhi.updated", msg.event, "vhi.updated");
    eq("private channel", msg.private, true);
    eq("payload vin upper", msg.payload.vin, "1HGCM82633A123456");
    eq("payload shopId numeric", msg.payload.shopId, 42);
    eq("payload reason passthrough", msg.payload.reason, "plan_cache_invalidate");
    ok("payload updatedAt is ISO", /^\d{4}-\d{2}-\d{2}T/.test(msg.payload.updatedAt));
  }

  // ---------- debounce ----------
  _resetVhiBroadcastStateForTests();
  {
    const { stub, calls } = makeFetchStub({ ok: true });
    const r1 = await broadcastVhiUpdated({
      vin: "AAA",
      shopId: 7,
      reason: "tekmetric_webhook",
      now: () => 1000,
      fetchImpl: stub,
    });
    const r2 = await broadcastVhiUpdated({
      vin: "AAA",
      shopId: 7,
      reason: "tekmetric_webhook",
      now: () => 1500, // within 750ms of last
      fetchImpl: stub,
    });
    eq("first call sent", r1, "sent");
    eq("second call debounced", r2, "debounced");
    eq("fetch called exactly once across burst", calls.length, 1);
  }

  _resetVhiBroadcastStateForTests();
  {
    const { stub, calls } = makeFetchStub({ ok: true });
    await broadcastVhiUpdated({
      vin: "AAA",
      shopId: 7,
      reason: "tekmetric_webhook",
      now: () => 1000,
      fetchImpl: stub,
    });
    const r = await broadcastVhiUpdated({
      vin: "BBB", // different VIN → independent bucket
      shopId: 7,
      reason: "tekmetric_webhook",
      now: () => 1100,
      fetchImpl: stub,
    });
    eq("different VIN not debounced", r, "sent");
    eq("two fetches issued", calls.length, 2);
  }

  // ---------- failure paths ----------
  _resetVhiBroadcastStateForTests();
  {
    const { stub } = makeFetchStub({ ok: false, status: 500, text: "boom" });
    const r = await broadcastVhiUpdated({
      vin: "FAIL",
      shopId: 1,
      reason: "fullpage_backfill",
      fetchImpl: stub,
    });
    eq("non-2xx returns failed (no throw)", r, "failed");
  }

  _resetVhiBroadcastStateForTests();
  {
    const throwingFetch: typeof fetch = (async () => {
      throw new Error("network down");
    }) as any;
    let didThrow = false;
    let r: string = "";
    try {
      r = await broadcastVhiUpdated({
        vin: "FAIL2",
        shopId: 1,
        reason: "fullpage_backfill",
        fetchImpl: throwingFetch,
      });
    } catch {
      didThrow = true;
    }
    ok("network throw is swallowed", !didThrow);
    eq("returns failed on network throw", r, "failed");
  }

  // ---------- config-missing while flag on ----------
  _resetVhiBroadcastStateForTests();
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  {
    const { stub, calls } = makeFetchStub({ ok: true });
    const r = await broadcastVhiUpdated({
      vin: "XYZ",
      shopId: 9,
      reason: "plan_cache_invalidate",
      fetchImpl: stub,
    });
    eq("missing SUPABASE_URL → disabled", r, "disabled");
    eq("no fetch attempted when URL missing", calls.length, 0);
  }

  // ---------- realtime-token route: cross-shop authz wiring ----------
  // Task #484 reviewer pin: a client-supplied `smsShopId` must NEVER end up in
  // the minted JWT's `shop_id` claim. The route must:
  //   1. Pass the caller's `userShopIds` (server-derived from auth.user) to
  //      findShopBySmsId so non-admins are scoped to shops they own.
  //   2. Mint the JWT with `shopResult.mosShopId` (the lookup-resolved MOS
  //      shopId), never with `body.smsShopId` or any other request input.
  //   3. Refuse with 403 when the lookup returns null.
  //
  // A regression that swapped any of those for client-controlled values would
  // let one shop's extension token join another shop's realtime channel.
  // findShopBySmsId itself is exhaustively covered by extension-shop-lookup
  // smoke; here we pin the route wiring as a source contract so a refactor
  // doesn't quietly undo it.
  {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "app/api/extension/realtime-token/route.ts",
      "utf8"
    );
    ok(
      "route uses server-derived userShopIds (not request body)",
      /findShopBySmsId\([\s\S]*?userShopIds[\s\S]*?\)/.test(src) &&
        /userShopIds\s*=\s*getUserShopIds\(auth\.user\)/.test(src)
    );
    ok(
      "route 403s when shop lookup returns null",
      /if\s*\(\s*!shopResult\s*\)\s*\{[\s\S]*?status:\s*403/.test(src)
    );
    ok(
      "route mints JWT with shopResult.mosShopId, not body.smsShopId",
      /signSupabaseJwt\(\s*mosShopId\s*,/.test(src) &&
        /const mosShopId = Number\(shopResult\.mosShopId\)/.test(src) &&
        !/signSupabaseJwt\([^)]*smsShopId/.test(src)
    );
    ok(
      "JWT payload pins shop_id to the resolved shopId arg",
      /shop_id:\s*String\(shopId\)/.test(src)
    );
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
}

run().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
