/**
 * Route-level smoke test for the Protractor webhook health cron — task #480.
 *
 * Run: `npx tsx tests/protractor-webhook-health.route.smoke.ts`
 *
 * Mirrors the pattern in `tests/tekmetric-webhook-health.route.smoke.ts`:
 * exercises the auth gate, the right Mongo collections being read, alert
 * inserts with per-(shop, kind, day) dedup, recovery detection, and the
 * single-consolidated-email contract via the `__deps` test seam on
 * `route.ts`. No real Mongo or Resend involvement.
 */

import assert from "node:assert/strict";

import { NextRequest } from "next/server";
import {
  GET,
  __deps,
} from "../app/api/cron/protractor-webhook-health/route";
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
const DAY_MS = 24 * HOUR_MS;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function run() {
  console.log("protractor-webhook-health route smoke");

  // (1) Auth gate: CRON_SECRET set, missing/wrong bearer → 401, no DB or
  //     email side effects on the deny path.
  {
    process.env.CRON_SECRET = "shhh";
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);

    const noAuth = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health"),
    );
    ok("401 when CRON_SECRET set and no Authorization header", noAuth.status === 401);

    const wrongAuth = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health", {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    ok("401 when CRON_SECRET set and wrong bearer", wrongAuth.status === 401);

    ok("auth deny does not touch the DB", fake.ops.length === 0);
    ok("auth deny does not send any email", sent.length === 0);

    delete process.env.CRON_SECRET;
  }

  // (2) Kill switch — PROTRACTOR_WEBHOOK_HEALTH_DISABLED short-circuits.
  {
    process.env.PROTRACTOR_WEBHOOK_HEALTH_DISABLED = "true";
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health"),
    );
    ok("disabled flag returns 200", res.status === 200);
    const body = await res.json();
    ok("disabled flag body says disabled", body.disabled === true);
    ok("disabled flag does not touch DB", fake.ops.length === 0);
    ok("disabled flag does not send email", sent.length === 0);
    delete process.env.PROTRACTOR_WEBHOOK_HEALTH_DISABLED;
  }

  // (3) Empty DB → reads shops, short-circuits "no Protractor shops".
  {
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health"),
    );
    ok("empty DB → 200", res.status === 200);
    const body = await res.json();
    ok("empty DB: scanned=0", body.scanned === 0);
    ok("empty DB: note present", body.note === "no Protractor shops");
    const finds = fake.ops.filter((o) => o.op === "find").map((o) => o.collection);
    ok("reads shops collection", finds.includes("shops"));
    ok(
      "skips callback-events / alerts / users when no shops exist",
      !finds.includes("protractor_callback_events") &&
        !finds.includes("protractor_webhook_health_alerts") &&
        !finds.includes("users") &&
        !fake.ops.some((o) => o.op === "aggregate"),
    );
  }

  // (4) Single silent shop with platform admins → one consolidated email
  //     per admin, dedup row inserted with kind=silent.
  {
    const fake = makeFakeDb({
      shops: [
        {
          shopId: 42,
          name: "Acme Auto",
          protractor: { configured: true },
        },
      ],
      protractor_callback_events: [],
      users: [
        { email: "ops1@example.com", isPlatformAdmin: true },
        { email: "ops2@example.com", isPlatformAdmin: true },
        { email: "owner@example.com", isPlatformAdmin: false },
      ],
      protractor_webhook_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health"),
    );
    ok("silent shop → 200", res.status === 200);
    const body = await res.json();
    ok("response: scanned=1", body.scanned === 1);
    ok("response: silent=1", body.silent === 1);
    ok("response: newSilentAlerts=1", body.newSilentAlerts === 1);
    ok("response: emailed=2 (one per platform admin)", body.emailed === 2);

    const shopsFinds = fake.ops.filter(
      (o) => o.op === "find" && o.collection === "shops",
    );
    ok("queries shops collection once", shopsFinds.length === 1);
    const shopsFilter = (shopsFinds[0] as any).filter;
    ok(
      "shops filter requires protractor.configured=true",
      shopsFilter?.["protractor.configured"] === true,
      `filter=${JSON.stringify(shopsFilter)}`,
    );

    const aggOps = fake.ops.filter(
      (o) => o.op === "aggregate" && o.collection === "protractor_callback_events",
    );
    ok(
      "aggregates callback events twice (24h + 7d windows)",
      aggOps.length === 2,
      `aggOps.length=${aggOps.length}`,
    );

    const inserts = fake.ops.filter(
      (o) =>
        o.op === "insertOne" &&
        o.collection === "protractor_webhook_health_alerts",
    );
    ok("exactly one alert row inserted for silent shop", inserts.length === 1);
    const doc = (inserts[0] as any).doc;
    ok("alert row: shopId=42", doc.shopId === 42);
    ok("alert row: alertKind=silent", doc.alertKind === "silent");
    ok(
      "alert row: alertDate is YYYY-MM-DD UTC for today",
      doc.alertDate === ymd(new Date()),
    );
    ok("alert row: createdAt set", doc.createdAt instanceof Date);

    ok(
      "creates unique index on (shopId, alertDate, alertKind)",
      fake.ops.some(
        (o) =>
          o.op === "createIndex" &&
          o.collection === "protractor_webhook_health_alerts" &&
          (o as any).spec.shopId === 1 &&
          (o as any).spec.alertDate === 1 &&
          (o as any).spec.alertKind === 1 &&
          (o as any).opts?.unique === true,
      ),
    );

    ok("sendEmail called once per platform admin", sent.length === 2);
    const recipients = sent.map((s) => s.to).sort();
    assert.deepEqual(recipients, ["ops1@example.com", "ops2@example.com"]);
    for (const email of sent) {
      ok(
        `subject includes silent count for ${email.to}`,
        typeof email.subject === "string" &&
          email.subject.includes("1 silent") &&
          email.subject.startsWith("[MOS] Protractor webhook health:"),
        `subject=${email.subject}`,
      );
      ok(
        `html names the affected shop for ${email.to}`,
        typeof email.html === "string" && email.html.includes("Acme Auto"),
      );
      ok(
        `html includes shop id for ${email.to}`,
        typeof email.html === "string" && email.html.includes(">42<"),
      );
      ok(
        `html cites the diagnostic surface for ${email.to}`,
        typeof email.html === "string" &&
          email.html.includes("/api/admin/sync-health/protractor"),
      );
    }
  }

  // (5) Idempotency: same-day re-run with dedup row present → no insert,
  //     no email; shop still appears in response so on-call has visibility.
  {
    const today = ymd(new Date());
    const fake = makeFakeDb({
      shops: [
        { shopId: 42, name: "Acme Auto", protractor: { configured: true } },
      ],
      protractor_callback_events: [],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      protractor_webhook_health_alerts: [
        {
          shopId: 42,
          alertDate: today,
          alertKind: "silent",
          createdAt: new Date(),
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health"),
    );
    const body = await res.json();
    ok("dedup: 200", res.status === 200);
    ok("dedup: silent still flagged in response", body.silent === 1);
    ok("dedup: newSilentAlerts=0", body.newSilentAlerts === 0);
    ok("dedup: emailed=0", body.emailed === 0);
    ok("dedup: no email sent", sent.length === 0);
    ok(
      "dedup: alerts collection unchanged",
      fake.collections.protractor_webhook_health_alerts.length === 1,
    );
  }

  // (6) Healthy shop with recent callbacks → not silent, no drop, no email.
  {
    const now = Date.now();
    const fake = makeFakeDb({
      shops: [
        { shopId: 77, name: "Healthy Shop", protractor: { configured: true } },
      ],
      protractor_callback_events: [
        { receivedAt: new Date(now - 1 * HOUR_MS), shopId: 77 },
        { receivedAt: new Date(now - 5 * HOUR_MS), shopId: 77 },
      ],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      protractor_webhook_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health"),
    );
    const body = await res.json();
    ok("healthy: 200", res.status === 200);
    ok("healthy: silent=0", body.silent === 0);
    ok("healthy: drops=0", body.drops === 0);
    ok("healthy: emailed=0", body.emailed === 0);
    ok("healthy: no email sent", sent.length === 0);
    ok(
      "healthy: no alert inserted",
      fake.collections.protractor_webhook_health_alerts.length === 0,
    );
  }

  // (7) Stale events (>24h) don't count — shop is still silent.
  {
    const now = Date.now();
    const fake = makeFakeDb({
      shops: [
        { shopId: 55, name: "Stale Shop", protractor: { configured: true } },
      ],
      protractor_callback_events: [
        { receivedAt: new Date(now - 36 * HOUR_MS), shopId: 55 },
      ],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      protractor_webhook_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health"),
    );
    const body = await res.json();
    ok("stale-only: 200", res.status === 200);
    ok("stale-only: silent=1", body.silent === 1);
    ok("stale-only: emailed=1", body.emailed === 1);
  }

  // (8) Recovery — previously-silent shop now has callbacks → recovery
  //     alert fires AND original silent alert is stamped resolvedAt.
  {
    const now = Date.now();
    const yesterday = ymd(new Date(now - 1 * DAY_MS));
    const fake = makeFakeDb({
      shops: [
        { shopId: 99, name: "Comeback Auto", protractor: { configured: true } },
      ],
      protractor_callback_events: [
        { receivedAt: new Date(now - 2 * HOUR_MS), shopId: 99 },
        { receivedAt: new Date(now - 4 * HOUR_MS), shopId: 99 },
      ],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      protractor_webhook_health_alerts: [
        {
          shopId: 99,
          alertDate: yesterday,
          alertKind: "silent",
          createdAt: new Date(now - 1 * DAY_MS),
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health"),
    );
    const body = await res.json();
    ok("recovery: 200", res.status === 200);
    ok("recovery: silent=0 (shop is delivering again)", body.silent === 0);
    ok("recovery: recovered=1", body.recovered === 1);
    ok("recovery: newRecoveryAlerts=1", body.newRecoveryAlerts === 1);
    ok("recovery: emailed=1", body.emailed === 1);

    const recoveryRows = fake.collections.protractor_webhook_health_alerts.filter(
      (r: any) => r.alertKind === "recovery",
    );
    ok("recovery: exactly one recovery row inserted", recoveryRows.length === 1);
    ok(
      "recovery: row carries silentSince=yesterday",
      recoveryRows[0].silentSince === yesterday,
    );

    const originalSilent = fake.collections.protractor_webhook_health_alerts.find(
      (r: any) =>
        r.shopId === 99 && r.alertKind === "silent" && r.alertDate === yesterday,
    );
    ok(
      "recovery: original silent alert stamped with resolvedAt",
      originalSilent?.resolvedAt instanceof Date,
    );
    ok(
      "recovery: original silent alert stamped with resolvedOn=today",
      originalSilent?.resolvedOn === ymd(new Date()),
    );

    ok(
      "recovery: subject includes 'recovered'",
      typeof sent[0]?.subject === "string" && sent[0].subject.includes("1 recovered"),
    );
    ok(
      "recovery: html lists the recovered shop",
      typeof sent[0]?.html === "string" && sent[0].html.includes("Comeback Auto"),
    );
  }

  // (9) Recovery dedup — re-running the cron same day after a recovery
  //     fire is a no-op (no additional recovery row, no email).
  {
    const now = Date.now();
    const today = ymd(new Date(now));
    const yesterday = ymd(new Date(now - 1 * DAY_MS));
    const fake = makeFakeDb({
      shops: [
        { shopId: 99, name: "Comeback Auto", protractor: { configured: true } },
      ],
      protractor_callback_events: [
        { receivedAt: new Date(now - 2 * HOUR_MS), shopId: 99 },
      ],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      protractor_webhook_health_alerts: [
        // Original silent alert already resolved by an earlier tick.
        {
          shopId: 99,
          alertDate: yesterday,
          alertKind: "silent",
          createdAt: new Date(now - 1 * DAY_MS),
          resolvedAt: new Date(),
          resolvedOn: today,
        },
        // Today's recovery alert already exists.
        {
          shopId: 99,
          alertDate: today,
          alertKind: "recovery",
          createdAt: new Date(),
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health"),
    );
    const body = await res.json();
    ok("recovery dedup: 200", res.status === 200);
    // The earlier silent alert is now resolved, so it won't be re-detected.
    ok("recovery dedup: recovered=0 (silent alert already resolved)", body.recovered === 0);
    ok("recovery dedup: newRecoveryAlerts=0", body.newRecoveryAlerts === 0);
    ok("recovery dedup: emailed=0", body.emailed === 0);
    ok("recovery dedup: no email sent", sent.length === 0);
    ok(
      "recovery dedup: alerts collection unchanged size",
      fake.collections.protractor_webhook_health_alerts.length === 2,
    );
  }

  // (10) Receipt drop — shop with enough 7d volume but <50% today.
  {
    const now = Date.now();
    const shopId = 33;
    const events: any[] = [];
    // 21 events scattered between 25h and 7d ago — all OUTSIDE the 24h
    // window but INSIDE the 7d window. Floor is 14 ✓; daily avg = 22/7 ≈ 3.14.
    for (let i = 0; i < 21; i++) {
      const hoursAgo = 25 + i * 7; // 25h, 32h, …, 165h (all <168h)
      events.push({
        receivedAt: new Date(now - hoursAgo * HOUR_MS),
        shopId,
      });
    }
    // 1 event in the last 24h: 1 < 0.5 * 3.14 ≈ 1.57 → drop fires.
    events.push({ receivedAt: new Date(now - 2 * HOUR_MS), shopId });
    const fake = makeFakeDb({
      shops: [
        { shopId, name: "Slowing Shop", protractor: { configured: true } },
      ],
      protractor_callback_events: events,
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      protractor_webhook_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health"),
    );
    const body = await res.json();
    ok("drop: 200", res.status === 200);
    ok("drop: silent=0 (still delivering some)", body.silent === 0);
    ok("drop: drops=1", body.drops === 1);
    ok("drop: newDropAlerts=1", body.newDropAlerts === 1);
    ok("drop: emailed=1", body.emailed === 1);
    ok(
      "drop: subject contains 'drop'",
      typeof sent[0]?.subject === "string" && sent[0].subject.includes("1 drop"),
    );
    ok(
      "drop: html lists the affected shop",
      typeof sent[0]?.html === "string" && sent[0].html.includes("Slowing Shop"),
    );

    const dropRows = fake.collections.protractor_webhook_health_alerts.filter(
      (r: any) => r.alertKind === "drop",
    );
    ok("drop: exactly one drop row inserted", dropRows.length === 1);
    ok("drop: row records eventsLast24h", dropRows[0].eventsLast24h === 1);
  }

  // (11) Consolidated digest — silent + drop + recovery in one email.
  {
    const now = Date.now();
    const yesterday = ymd(new Date(now - 1 * DAY_MS));
    const dropShopEvents: any[] = [];
    const dropShopId = 200;
    // Same shape as test (10): 21 events all OUTSIDE the 24h window but
    // INSIDE the 7d window, plus a single event in the last 24h.
    for (let i = 0; i < 21; i++) {
      const hoursAgo = 25 + i * 7;
      dropShopEvents.push({
        receivedAt: new Date(now - hoursAgo * HOUR_MS),
        shopId: dropShopId,
      });
    }
    dropShopEvents.push({ receivedAt: new Date(now - 1 * HOUR_MS), shopId: dropShopId });
    const fake = makeFakeDb({
      shops: [
        { shopId: 100, name: "Silent Shop", protractor: { configured: true } },
        { shopId: dropShopId, name: "Drop Shop", protractor: { configured: true } },
        { shopId: 300, name: "Recovered Shop", protractor: { configured: true } },
      ],
      protractor_callback_events: [
        ...dropShopEvents,
        { receivedAt: new Date(now - 2 * HOUR_MS), shopId: 300 },
      ],
      users: [
        { email: "ops1@example.com", isPlatformAdmin: true },
        { email: "ops2@example.com", isPlatformAdmin: true },
      ],
      protractor_webhook_health_alerts: [
        {
          shopId: 300,
          alertDate: yesterday,
          alertKind: "silent",
          createdAt: new Date(now - 1 * DAY_MS),
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health"),
    );
    const body = await res.json();
    ok("digest: 200", res.status === 200);
    ok("digest: silent=1", body.silent === 1);
    ok("digest: drops=1", body.drops === 1);
    ok("digest: recovered=1", body.recovered === 1);
    ok("digest: emailed=2 (one per admin, one email each)", body.emailed === 2);
    ok("digest: exactly one email per admin", sent.length === 2);
    for (const email of sent) {
      ok(
        `digest: subject summarizes all three for ${email.to}`,
        typeof email.subject === "string" &&
          email.subject.includes("1 silent") &&
          email.subject.includes("1 drop") &&
          email.subject.includes("1 recovered"),
        `subject=${email.subject}`,
      );
      ok(
        `digest: html mentions silent shop for ${email.to}`,
        typeof email.html === "string" && email.html.includes("Silent Shop"),
      );
      ok(
        `digest: html mentions drop shop for ${email.to}`,
        typeof email.html === "string" && email.html.includes("Drop Shop"),
      );
      ok(
        `digest: html mentions recovered shop for ${email.to}`,
        typeof email.html === "string" && email.html.includes("Recovered Shop"),
      );
    }
  }

  // (12) Silent shop but no platform admins configured → no email, but
  //      the dedup row is still inserted so state isn't lost.
  {
    const fake = makeFakeDb({
      shops: [
        { shopId: 88, name: "Lonely Shop", protractor: { configured: true } },
      ],
      protractor_callback_events: [],
      users: [],
      protractor_webhook_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/protractor-webhook-health"),
    );
    const body = await res.json();
    ok("no-admins: 200", res.status === 200);
    ok("no-admins: silent=1", body.silent === 1);
    ok("no-admins: newSilentAlerts=1", body.newSilentAlerts === 1);
    ok("no-admins: emailed=0", body.emailed === 0);
    ok("no-admins: no email sent", sent.length === 0);
    ok(
      "no-admins: dedup row still inserted",
      fake.collections.protractor_webhook_health_alerts.length === 1,
    );
  }

  Object.assign(__deps, ORIGINAL_DEPS);

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll protractor-webhook-health route smoke assertions passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
