/**
 * Route-level smoke test for the webhook subscription sweep cron
 * (task #569 — keep data fresh via webhooks at scale).
 *
 * Run: `npx tsx tests/webhook-subscription-sweep.route.smoke.ts`
 *
 * Mirrors the pattern in `tests/tekmetric-webhook-health.route.smoke.ts`:
 * exercises the auth gate, the kill switch, the right shop filters per
 * provider, and the per-provider verify/repair calls + roll-up counts via
 * the `__deps` test seam on `route.ts`. The provider helpers themselves are
 * stubbed — this test owns the SWEEP orchestration (who gets scanned, how
 * outcomes are tallied), not the helpers' internals (those have their own
 * coverage / are gated).
 */

import { NextRequest } from "next/server";
import {
  GET,
  __deps,
} from "../app/api/cron/webhook-subscription-sweep/route";
import { makeFakeDb } from "./utils/fake-mongo";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ORIGINAL_DEPS = { ...__deps };

function installFakes(
  db: any,
  opts: {
    tekImpl?: (a: any) => Promise<any>;
    protractorImpl?: (a: any) => Promise<any>;
  } = {},
) {
  const tekCalls: any[] = [];
  const protractorCalls: any[] = [];
  __deps.getDb = (async () => db) as any;
  __deps.subscribeShopToTekmetricWebhooks = (async (a: any) => {
    tekCalls.push(a);
    return opts.tekImpl
      ? await opts.tekImpl(a)
      : { ok: true, status: 200 };
  }) as any;
  __deps.ensureProtractorWebhookSubscription = (async (a: any) => {
    protractorCalls.push(a);
    return opts.protractorImpl
      ? await opts.protractorImpl(a)
      : { ok: true, shopId: a.shopId, generatedToken: false };
  }) as any;
  return { tekCalls, protractorCalls };
}

async function run() {
  console.log("webhook-subscription-sweep route smoke");

  // (1) Auth gate: CRON_SECRET set → missing / wrong bearer → 401, no work.
  {
    process.env.CRON_SECRET = "shhh";
    const fake = makeFakeDb({});
    const calls = installFakes(fake.db);

    const noAuth = await GET(
      new NextRequest("http://localhost/api/cron/webhook-subscription-sweep"),
    );
    ok("401 when CRON_SECRET set and no auth header", noAuth.status === 401);

    const wrongAuth = await GET(
      new NextRequest("http://localhost/api/cron/webhook-subscription-sweep", {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    ok("401 when CRON_SECRET set and wrong bearer", wrongAuth.status === 401);
    ok("auth deny does not touch the DB", fake.ops.length === 0);
    ok(
      "auth deny does not call provider helpers",
      calls.tekCalls.length === 0 && calls.protractorCalls.length === 0,
    );
    delete process.env.CRON_SECRET;
  }

  // (2) Auth: CRON_SECRET unset → allowed; correct bearer → allowed.
  {
    delete process.env.CRON_SECRET;
    const fake = makeFakeDb({});
    installFakes(fake.db);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/webhook-subscription-sweep"),
    );
    ok("200 when CRON_SECRET unset", res.status === 200);

    process.env.CRON_SECRET = "shhh";
    const fake2 = makeFakeDb({});
    installFakes(fake2.db);
    const res2 = await GET(
      new NextRequest("http://localhost/api/cron/webhook-subscription-sweep", {
        headers: { authorization: "Bearer shhh" },
      }),
    );
    ok("200 when CRON_SECRET matches bearer", res2.status === 200);
    delete process.env.CRON_SECRET;
  }

  // (3) Kill switch: WEBHOOK_SUBSCRIPTION_SWEEP_DISABLED=true → no-op.
  {
    process.env.WEBHOOK_SUBSCRIPTION_SWEEP_DISABLED = "true";
    const fake = makeFakeDb({
      shops: [{ shopId: 1, tekmetric: { shopId: 100 } }],
    });
    const calls = installFakes(fake.db);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/webhook-subscription-sweep"),
    );
    const body = await res.json();
    ok("kill switch: 200", res.status === 200);
    ok("kill switch: disabled flag in body", body.disabled === true);
    ok(
      "kill switch: no DB reads / provider calls",
      fake.ops.length === 0 &&
        calls.tekCalls.length === 0 &&
        calls.protractorCalls.length === 0,
    );
    delete process.env.WEBHOOK_SUBSCRIPTION_SWEEP_DISABLED;
  }

  // (4) Correct per-provider shop filters.
  {
    const fake = makeFakeDb({ shops: [] });
    installFakes(fake.db);
    await GET(
      new NextRequest("http://localhost/api/cron/webhook-subscription-sweep"),
    );
    const shopFinds = fake.ops.filter(
      (o) => o.op === "find" && o.collection === "shops",
    ) as any[];
    ok("queries shops collection twice (one per provider)", shopFinds.length === 2);
    ok(
      "tekmetric filter requires nested tekmetric.shopId to exist",
      shopFinds.some(
        (o) => o.filter?.["tekmetric.shopId"]?.$exists === true,
      ),
    );
    ok(
      "protractor filter requires protractor.configured=true",
      shopFinds.some((o) => o.filter?.["protractor.configured"] === true),
    );
  }

  // (5) Tekmetric: subscribed / skipped (disabled) / failed are tallied,
  //     and each shop's tekmetric.shopId + mosShopId are passed through.
  {
    const fake = makeFakeDb({
      shops: [
        { shopId: "mos-a", tekmetric: { shopId: 100 } },
        { shopId: "mos-b", tekmetric: { shopId: 200 } },
        { shopId: "mos-c", tekmetric: { shopId: 300 } },
      ],
    });
    const calls = installFakes(fake.db, {
      tekImpl: async (a: any) => {
        if (a.tekmetricShopId === 100) return { ok: true, status: 200 };
        if (a.tekmetricShopId === 200)
          return { ok: false, reason: "auto_subscribe_disabled" };
        return { ok: false, reason: "http_500" };
      },
    });
    const res = await GET(
      new NextRequest("http://localhost/api/cron/webhook-subscription-sweep"),
    );
    const body = await res.json();
    ok("tek: scanned=3", body.tekmetric.scanned === 3);
    ok("tek: subscribed=1", body.tekmetric.subscribed === 1);
    ok("tek: skipped=1 (auto_subscribe_disabled)", body.tekmetric.skipped === 1);
    ok("tek: failed=1", body.tekmetric.failed === 1);
    ok(
      "tek: failure detail captured for the http_500 shop",
      body.tekmetric.failures.length === 1 &&
        body.tekmetric.failures[0].tekmetricShopId === 300 &&
        body.tekmetric.failures[0].reason === "http_500",
    );
    ok("tek: helper called once per shop", calls.tekCalls.length === 3);
    ok(
      "tek: passes tekmetricShopId + mosShopId",
      calls.tekCalls[0].tekmetricShopId === 100 &&
        calls.tekCalls[0].mosShopId === "mos-a",
    );
  }

  // (6) Protractor: ensured / tokensGenerated / failed tallied; db handle
  //     reused (passed through to the helper); shopId passed through.
  {
    const fake = makeFakeDb({
      shops: [
        { shopId: 11, protractor: { configured: true } },
        { shopId: 22, protractor: { configured: true } },
        { shopId: 33, protractor: { configured: true } },
      ],
    });
    const calls = installFakes(fake.db, {
      protractorImpl: async (a: any) => {
        if (a.shopId === 11) return { ok: true, shopId: 11, generatedToken: false };
        if (a.shopId === 22) return { ok: true, shopId: 22, generatedToken: true };
        return { ok: false, shopId: 33, reason: "invalid_shop_id" };
      },
    });
    const res = await GET(
      new NextRequest("http://localhost/api/cron/webhook-subscription-sweep"),
    );
    const body = await res.json();
    ok("protractor: scanned=3", body.protractor.scanned === 3);
    ok("protractor: ensured=2", body.protractor.ensured === 2);
    ok("protractor: tokensGenerated=1 (repair)", body.protractor.tokensGenerated === 1);
    ok("protractor: failed=1", body.protractor.failed === 1);
    ok(
      "protractor: failure detail captured",
      body.protractor.failures.length === 1 &&
        body.protractor.failures[0].shopId === 33,
    );
    ok("protractor: helper called once per shop", calls.protractorCalls.length === 3);
    ok(
      "protractor: passes shopId + reuses db handle",
      calls.protractorCalls[0].shopId === 11 &&
        calls.protractorCalls[0].db === fake.db,
    );
  }

  // (7) Throwing helper is caught and counted as failed (never crashes sweep).
  {
    const fake = makeFakeDb({
      shops: [{ shopId: "mos-x", tekmetric: { shopId: 999 } }],
    });
    installFakes(fake.db, {
      tekImpl: async () => {
        throw new Error("boom");
      },
    });
    const res = await GET(
      new NextRequest("http://localhost/api/cron/webhook-subscription-sweep"),
    );
    const body = await res.json();
    ok("throwing helper: 200 (sweep survives)", res.status === 200);
    ok("throwing helper: counted as failed", body.tekmetric.failed === 1);
    ok(
      "throwing helper: reason captured",
      body.tekmetric.failures[0]?.reason === "boom",
    );
  }

  Object.assign(__deps, ORIGINAL_DEPS);

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll webhook-subscription-sweep route smoke assertions passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
