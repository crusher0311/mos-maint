/**
 * Route-level smoke test for the Tekmetric webhook health cron.
 *
 * Run: `npx tsx tests/tekmetric-webhook-health.route.smoke.ts`
 *
 * Mirrors the pattern in `tests/tekmetric-backfill-health.route.smoke.ts`
 * and `tests/backfill-chunk-speed-health.route.smoke.ts`: exercises the
 * auth gate, the right Mongo collections being read, alert-row inserts
 * and idempotent dedup, and the email payload (subject + HTML) actually
 * sent for each platform admin via the `__deps` test seam on `route.ts`.
 * No real Mongo / Resend involvement.
 *
 * The webhook-health route alerts when a Tekmetric-connected shop has
 * delivered zero webhook events in the last 24h. Dedup is per
 * (tekmetricShopId, alertDate-UTC) via a unique index, so re-running the
 * cron the same day must be a no-op for already-alerted shops.
 */

import assert from "node:assert/strict";

import { NextRequest } from "next/server";
import {
  GET,
  __deps,
} from "../app/api/cron/tekmetric-webhook-health/route";
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

function installFakes(db: any, sentEmails: any[]) {
  __deps.getDb = (async () => db) as any;
  __deps.sendEmail = (async (args: any) => {
    sentEmails.push(args);
    return { ok: true };
  }) as any;
}

const ORIGINAL_DEPS = { ...__deps };

const HOUR_MS = 60 * 60 * 1000;

async function run() {
  console.log("tekmetric-webhook-health route smoke");

  // (1) Auth gate: CRON_SECRET set, missing/wrong bearer → 401, no DB or
  //     email side effects on the deny path.
  {
    process.env.CRON_SECRET = "shhh";
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);

    const noAuth = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-webhook-health"),
    );
    ok("401 when CRON_SECRET set and no Authorization header", noAuth.status === 401);
    const body401 = await noAuth.json();
    ok("401 body has error field", body401.error === "Unauthorized");

    const wrongAuth = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-webhook-health", {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    ok("401 when CRON_SECRET set and wrong bearer", wrongAuth.status === 401);

    ok(
      "auth deny does not touch the DB",
      fake.ops.length === 0,
      `ops=${JSON.stringify(fake.ops)}`,
    );
    ok("auth deny does not send any email", sent.length === 0);

    delete process.env.CRON_SECRET;
  }

  // (2) Auth gate: CRON_SECRET unset → requests are allowed.
  {
    delete process.env.CRON_SECRET;
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-webhook-health"),
    );
    ok("200 when CRON_SECRET is unset (no auth required)", res.status === 200);
  }

  // (3) Auth gate: correct bearer with CRON_SECRET set → 200.
  {
    process.env.CRON_SECRET = "shhh";
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-webhook-health", {
        headers: { authorization: "Bearer shhh" },
      }),
    );
    ok("200 when CRON_SECRET matches bearer", res.status === 200);
    delete process.env.CRON_SECRET;
  }

  // (4) Empty DB → reads the shops collection, short-circuits with the
  //     "no Tekmetric shops" note, and never touches the logs / alerts /
  //     users collections.
  {
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-webhook-health"),
    );
    ok("empty DB → 200", res.status === 200);
    const body = await res.json();
    ok("empty DB: scanned=0", body.scanned === 0);
    ok("empty DB: silent=0", body.silent === 0);
    ok("empty DB: alerted=0", body.alerted === 0);
    ok("empty DB: short-circuit note present", body.note === "no Tekmetric shops");

    const findCollections = fake.ops
      .filter((o) => o.op === "find")
      .map((o) => o.collection);
    ok(
      "reads shops collection",
      findCollections.includes("shops"),
      `findCollections=${JSON.stringify(findCollections)}`,
    );
    ok(
      "skips webhook logs / alerts / users when no Tekmetric shops exist",
      !findCollections.includes("tekmetric_webhook_logs") &&
        !findCollections.includes("tekmetric_webhook_health_alerts") &&
        !findCollections.includes("users") &&
        !fake.ops.some((o) => o.op === "aggregate"),
    );
  }

  // (5) Single silent shop with platform admins → email sent per admin
  //     with the expected subject + HTML, and a dedup row is inserted
  //     into tekmetric_webhook_health_alerts.
  {
    const fake = makeFakeDb({
      shops: [
        {
          shopId: "mos-acme",
          name: "Acme Auto",
          tekmetric: { shopId: 4242 },
        },
      ],
      tekmetric_webhook_logs: [
        // No events at all → silent.
      ],
      users: [
        { _id: "u1", email: "ops1@example.com", isPlatformAdmin: true },
        { _id: "u2", email: "ops2@example.com", isPlatformAdmin: true },
        { _id: "u3", email: "shop-owner@example.com", isPlatformAdmin: false },
      ],
      tekmetric_webhook_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-webhook-health"),
    );
    ok("silent shop → 200", res.status === 200);

    const body = await res.json();
    ok("response: scanned=1", body.scanned === 1);
    ok("response: silent=1", body.silent === 1);
    ok("response: newAlerts=1", body.newAlerts === 1);
    ok("response: alreadyAlertedToday=0", body.alreadyAlertedToday === 0);
    ok("response: emailed once per platform admin (2)", body.emailed === 2);
    ok(
      "response: silentShops includes the offender",
      Array.isArray(body.silentShops) &&
        body.silentShops.length === 1 &&
        body.silentShops[0].tekmetricShopId === 4242 &&
        body.silentShops[0].mosShopId === "mos-acme" &&
        body.silentShops[0].name === "Acme Auto" &&
        body.silentShops[0].eventsLast24h === 0,
    );

    // Reads: shops (with $exists on nested tekmetric.shopId), webhook
    // logs aggregate, alerts collection check, users for admins.
    const shopsFinds = fake.ops.filter(
      (o) => o.op === "find" && o.collection === "shops",
    );
    ok("queries shops collection once", shopsFinds.length === 1);
    const shopsFilter = (shopsFinds[0] as any).filter;
    ok(
      "shops filter requires nested tekmetric.shopId to exist",
      shopsFilter?.["tekmetric.shopId"]?.$exists === true,
      `filter=${JSON.stringify(shopsFilter)}`,
    );

    const aggOps = fake.ops.filter(
      (o) => o.op === "aggregate" && o.collection === "tekmetric_webhook_logs",
    );
    ok("aggregates tekmetric_webhook_logs once for the 24h window", aggOps.length === 1);

    // Users lookup filters to platform admins with an email.
    const usersFinds = fake.ops.filter(
      (o) => o.op === "find" && o.collection === "users",
    );
    ok("queries users collection once", usersFinds.length === 1);
    const usersFilter = (usersFinds[0] as any).filter;
    ok(
      "users filter: isPlatformAdmin=true",
      usersFilter?.isPlatformAdmin === true,
    );
    ok(
      "users filter: requires non-null email",
      usersFilter?.email && usersFilter.email.$exists === true && usersFilter.email.$ne === null,
    );

    // Dedup row inserted with the per-day key.
    const inserts = fake.ops.filter(
      (o) =>
        o.op === "insertOne" &&
        o.collection === "tekmetric_webhook_health_alerts",
    );
    ok(
      "inserts exactly one alert row for the silent shop",
      inserts.length === 1,
      `inserts=${JSON.stringify(inserts)}`,
    );
    const insertedDoc = (inserts[0] as any).doc;
    ok("alert row: tekmetricShopId=4242", insertedDoc.tekmetricShopId === 4242);
    ok("alert row: mosShopId carried through", insertedDoc.mosShopId === "mos-acme");
    ok(
      "alert row: alertDate is YYYY-MM-DD UTC for today",
      typeof insertedDoc.alertDate === "string" &&
        insertedDoc.alertDate === new Date().toISOString().slice(0, 10),
    );
    ok("alert row: createdAt set", insertedDoc.createdAt instanceof Date);
    ok(
      "alert row: persisted to the dedup collection",
      fake.collections.tekmetric_webhook_health_alerts.length === 1,
    );

    // Unique index is created defensively.
    ok(
      "creates unique index on (tekmetricShopId, alertDate)",
      fake.ops.some(
        (o) =>
          o.op === "createIndex" &&
          o.collection === "tekmetric_webhook_health_alerts" &&
          (o as any).spec.tekmetricShopId === 1 &&
          (o as any).spec.alertDate === 1 &&
          (o as any).opts?.unique === true,
      ),
    );

    // Email assertions: one per platform admin, correct subject + HTML.
    ok("sendEmail called once per platform admin", sent.length === 2);
    const recipients = sent.map((s) => s.to).sort();
    assert.deepEqual(recipients, ["ops1@example.com", "ops2@example.com"]);
    ok("recipients are the two platform admins (not the shop owner)", true);

    for (const email of sent) {
      ok(
        `subject names silent count for ${email.to}`,
        email.subject === "[MOS] Tekmetric webhook silence: 1 shop(s) flagged",
        `subject=${email.subject}`,
      );
      ok(
        `html names the affected shop for ${email.to}`,
        typeof email.html === "string" && email.html.includes("Acme Auto"),
      );
      ok(
        `html includes the Tekmetric shop id for ${email.to}`,
        typeof email.html === "string" && email.html.includes(">4242<"),
      );
      ok(
        `html includes the MOS shop id for ${email.to}`,
        typeof email.html === "string" && email.html.includes(">mos-acme<"),
      );
      ok(
        `html cites the diagnostic surface for ${email.to}`,
        typeof email.html === "string" &&
          email.html.includes("/api/cron/tekmetric-webhook-health"),
      );
    }
  }

  // (6) Idempotency: re-running the cron the same day with a dedup row
  //     already present → no insert, no email, but the silent shop still
  //     shows in the response so on-call has visibility.
  {
    const today = new Date().toISOString().slice(0, 10);
    const fake = makeFakeDb({
      shops: [
        {
          shopId: "mos-acme",
          name: "Acme Auto",
          tekmetric: { shopId: 4242 },
        },
      ],
      tekmetric_webhook_logs: [],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      tekmetric_webhook_health_alerts: [
        {
          tekmetricShopId: 4242,
          mosShopId: "mos-acme",
          alertDate: today,
          createdAt: new Date(),
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-webhook-health"),
    );
    const body = await res.json();
    ok("dedup: 200", res.status === 200);
    ok("dedup: silent=1 (still flagged)", body.silent === 1);
    ok("dedup: newAlerts=0", body.newAlerts === 0);
    ok("dedup: alreadyAlertedToday=1", body.alreadyAlertedToday === 1);
    ok("dedup: emailed=0", body.emailed === 0);
    ok("dedup: no email sent", sent.length === 0);
    ok(
      "dedup: alert collection unchanged (still one row)",
      fake.collections.tekmetric_webhook_health_alerts.length === 1,
    );
  }

  // (7) Healthy shop with webhook events in the window → not silent, no
  //     alert row inserted, no email.
  {
    const now = Date.now();
    const fake = makeFakeDb({
      shops: [
        {
          shopId: "mos-good",
          name: "Healthy Shop",
          tekmetric: { shopId: 7777 },
        },
      ],
      tekmetric_webhook_logs: [
        {
          receivedAt: new Date(now - 1 * HOUR_MS),
          data: { shopId: 7777 },
        },
        {
          receivedAt: new Date(now - 6 * HOUR_MS),
          // Nested-RO shape — also valid shop attribution.
          data: { repairOrder: { shopId: 7777 } },
        },
      ],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      tekmetric_webhook_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-webhook-health"),
    );
    const body = await res.json();
    ok("healthy: 200", res.status === 200);
    ok("healthy: scanned=1", body.scanned === 1);
    ok("healthy: silent=0", body.silent === 0);
    ok("healthy: newAlerts=0", body.newAlerts === 0);
    ok("healthy: emailed=0", body.emailed === 0);
    ok("healthy: no email sent", sent.length === 0);
    ok(
      "healthy: no alert row inserted",
      fake.collections.tekmetric_webhook_health_alerts.length === 0 &&
        !fake.ops.some(
          (o) =>
            o.op === "insertOne" &&
            o.collection === "tekmetric_webhook_health_alerts",
        ),
    );
    // Users lookup is short-circuited when nothing fires.
    ok(
      "healthy: skips users lookup",
      !fake.ops.some((o) => o.op === "find" && o.collection === "users"),
    );
  }

  // (8) Stale events (older than 24h) must NOT count as activity → the
  //     shop is still silent and we still page.
  {
    const now = Date.now();
    const fake = makeFakeDb({
      shops: [
        {
          shopId: "mos-stale",
          name: "Stale Shop",
          tekmetric: { shopId: 5555 },
        },
      ],
      tekmetric_webhook_logs: [
        // 36h ago — outside the 24h window.
        {
          receivedAt: new Date(now - 36 * HOUR_MS),
          data: { shopId: 5555 },
        },
      ],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      tekmetric_webhook_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-webhook-health"),
    );
    const body = await res.json();
    ok("stale-only: 200", res.status === 200);
    ok("stale-only: silent=1", body.silent === 1);
    ok("stale-only: newAlerts=1", body.newAlerts === 1);
    ok("stale-only: emailed=1", body.emailed === 1);
  }

  // (9) Silent shop but no platform admins configured → no email, but
  //     the dedup row is still inserted so we don't lose state on the
  //     next run.
  {
    const fake = makeFakeDb({
      shops: [
        {
          shopId: "mos-lonely",
          name: "Lonely Shop",
          tekmetric: { shopId: 8888 },
        },
      ],
      tekmetric_webhook_logs: [],
      users: [], // no platform admins
      tekmetric_webhook_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-webhook-health"),
    );
    const body = await res.json();
    ok("no-admins: 200", res.status === 200);
    ok("no-admins: silent=1", body.silent === 1);
    ok("no-admins: newAlerts=1 (state still recorded)", body.newAlerts === 1);
    ok("no-admins: emailed=0", body.emailed === 0);
    ok("no-admins: no email sent", sent.length === 0);
    ok(
      "no-admins: dedup row was still inserted",
      fake.collections.tekmetric_webhook_health_alerts.length === 1,
    );
  }

  Object.assign(__deps, ORIGINAL_DEPS);

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll tekmetric-webhook-health route smoke assertions passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
