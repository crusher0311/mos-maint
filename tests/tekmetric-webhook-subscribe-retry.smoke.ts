/**
 * Task #1089 — webhook subscription sweep retry behavior.
 *
 * Run: `npx tsx tests/tekmetric-webhook-subscribe-retry.smoke.ts`
 *
 * Exercises `subscribeShopToTekmetricWebhooks` through its injectable deps:
 *   - transient failures (network, 5xx, 429) are retried with backoff
 *   - permanent failures (other 4xx) fail fast (no retry)
 *   - the gate flag + missing-env early exits still apply
 */

import { subscribeShopToTekmetricWebhooks } from "../lib/integrations/tekmetric/webhook-subscribe";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function res(status: number, body: any = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

const noSleep = async () => {};
const getToken = async () => "test-token";
// Capture persistence instead of touching Mongo/PG (dev Mongo is prod!).
const persisted: any[] = [];
const persist = (async (tekmetricShopId: number, set: any, setOnInsert: any) => {
  persisted.push({ tekmetricShopId, set, setOnInsert });
}) as any;

async function run() {
  console.log("tekmetric webhook-subscribe retry smoke");

  // Env plumbing for the enabled path. The persistence write inside the
  // helper soft-fails on its own (it catches), so no Mongo/PG needed here.
  process.env.TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE = "true";
  process.env.TEKMETRIC_WEBHOOK_SUBSCRIBE_URL_TEMPLATE = "https://tek.example/api/v1/shop/{shopId}/webhooks";
  process.env.TEKMETRIC_WEBHOOK_PUBLIC_URL = "https://mos.example/api/webhooks/tekmetric";

  // (1) 500 then 200 → retried, ends ok, attempts=2.
  {
    let calls = 0;
    const fetchImpl = (async (url: any) => {
      calls++;
      ok("URL template expands {shopId}", String(url).includes("/shop/123/"), String(url));
      return calls === 1 ? res(500) : res(200, { id: "sub-1" });
    }) as any;
    const r = await subscribeShopToTekmetricWebhooks(
      { tekmetricShopId: 123 },
      { fetchImpl, getToken, sleep: noSleep, persist },
    );
    ok("500→200: ends ok", r.ok === true);
    ok("500→200: two attempts", r.attempts === 2 && calls === 2, `attempts=${r.attempts} calls=${calls}`);
    ok("500→200: subscriptionId captured", r.ok && r.subscriptionId === "sub-1");
  }

  // (2) 429 is transient → retried up to max attempts (default 3), stays failed.
  {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return res(429);
    }) as any;
    const r = await subscribeShopToTekmetricWebhooks(
      { tekmetricShopId: 1 },
      { fetchImpl, getToken, sleep: noSleep, persist },
    );
    ok("429: retried to max attempts", calls === 3 && r.attempts === 3, `calls=${calls}`);
    ok("429: final result failed with http_429", !r.ok && (r as any).reason === "http_429");
  }

  // (3) Network error is transient → retried; recovers on later attempt.
  {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNRESET");
      return res(201, { subscriptionId: "sub-2" });
    }) as any;
    const r = await subscribeShopToTekmetricWebhooks(
      { tekmetricShopId: 1 },
      { fetchImpl, getToken, sleep: noSleep, persist },
    );
    ok("network errors retried then recover", r.ok === true && calls === 3);
  }

  // (4) 400 is permanent → NO retry.
  {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return res(400, { error: "bad request" });
    }) as any;
    const r = await subscribeShopToTekmetricWebhooks(
      { tekmetricShopId: 1 },
      { fetchImpl, getToken, sleep: noSleep, persist },
    );
    ok("400: fails fast (one attempt)", calls === 1 && r.attempts === 1, `calls=${calls}`);
    ok("400: reason http_400", !r.ok && (r as any).reason === "http_400");
  }

  // (5) Backoff sleeps happen between retries (not after the final attempt).
  {
    const sleeps: number[] = [];
    const fetchImpl = (async () => res(503)) as any;
    await subscribeShopToTekmetricWebhooks(
      { tekmetricShopId: 1 },
      { fetchImpl, getToken, sleep: async (ms) => { sleeps.push(ms); }, persist },
    );
    ok("backoff: 2 sleeps for 3 attempts", sleeps.length === 2, JSON.stringify(sleeps));
    ok("backoff: exponential", sleeps.length === 2 && sleeps[1] === sleeps[0] * 2, JSON.stringify(sleeps));
  }

  // (6) Gate flag off → early exit, no fetch.
  {
    process.env.TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE = "false";
    let calls = 0;
    const fetchImpl = (async () => { calls++; return res(200); }) as any;
    const r = await subscribeShopToTekmetricWebhooks(
      { tekmetricShopId: 1 },
      { fetchImpl, getToken, sleep: noSleep, persist },
    );
    ok("flag off: auto_subscribe_disabled, no fetch", !r.ok && (r as any).reason === "auto_subscribe_disabled" && calls === 0);
    process.env.TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE = "true";
  }

  // (7) Missing env → early exit, no fetch.
  {
    const saved = process.env.TEKMETRIC_WEBHOOK_SUBSCRIBE_URL_TEMPLATE;
    delete process.env.TEKMETRIC_WEBHOOK_SUBSCRIBE_URL_TEMPLATE;
    let calls = 0;
    const fetchImpl = (async () => { calls++; return res(200); }) as any;
    const r = await subscribeShopToTekmetricWebhooks(
      { tekmetricShopId: 1 },
      { fetchImpl, getToken, sleep: noSleep, persist },
    );
    ok("missing env: fails without fetch", !r.ok && (r as any).reason.startsWith("missing_env") && calls === 0);
    process.env.TEKMETRIC_WEBHOOK_SUBSCRIBE_URL_TEMPLATE = saved;
  }

  delete process.env.TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE;
  delete process.env.TEKMETRIC_WEBHOOK_SUBSCRIBE_URL_TEMPLATE;
  delete process.env.TEKMETRIC_WEBHOOK_PUBLIC_URL;

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll tekmetric webhook-subscribe retry assertions passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
