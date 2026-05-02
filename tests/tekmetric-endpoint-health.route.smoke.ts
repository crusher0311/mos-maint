/**
 * Route-level smoke test for the Tekmetric endpoint outage alerter cron.
 *
 * Run: `npx tsx tests/tekmetric-endpoint-health.route.smoke.ts`
 *
 * Mirrors the pattern in `tests/tekmetric-webhook-health.route.smoke.ts`:
 * exercises the auth gate, the right Mongo collections being read, the
 * fully-failing-shops trigger, the global-error-rate trigger, the
 * sub-threshold no-op path, the dedup-row insert, the recovery-row
 * delete, and the email payload (subject + HTML) actually sent for each
 * platform admin via the `__deps` test seam on `route.ts`. No real Mongo
 * / Resend involvement.
 *
 * The endpoint-health route alerts when a Tekmetric endpointShape is
 * regressed for the whole fleet — fully failing across N distinct shops,
 * or globally above a tunable error-rate threshold over a short rolling
 * window. Dedup is per endpointShape (one active alert per shape) and
 * recovery clears the dedup row so the next outage repages.
 */

import assert from "node:assert/strict";

import { NextRequest } from "next/server";
import {
  GET,
  __deps,
} from "../app/api/cron/tekmetric-endpoint-health/route";
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

const MIN_AGO = (m: number) => new Date(Date.now() - m * 60 * 1000);

/** Build a single fake report row in the recent window. */
function rep(
  shape: string,
  shopId: number | null,
  isError: boolean,
  minutesAgo = 5,
) {
  return {
    endpointShape: shape,
    mosShopId: shopId,
    smsShopId: shopId == null ? null : `sms-${shopId}`,
    isError,
    occurredAt: MIN_AGO(minutesAgo),
  };
}

/** Convenience: N reports in a row for one (shape, shop). */
function reps(
  shape: string,
  shopId: number | null,
  count: number,
  isError: boolean,
) {
  return Array.from({ length: count }, () => rep(shape, shopId, isError));
}

async function run() {
  console.log("tekmetric-endpoint-health route smoke");

  // (1) Auth gate: CRON_SECRET set, missing/wrong bearer → 401, no DB
  //     side effects on the deny path.
  {
    process.env.CRON_SECRET = "shhh";
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);

    const noAuth = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health"),
    );
    ok("401 when CRON_SECRET set and no Authorization header", noAuth.status === 401);
    const body401 = await noAuth.json();
    ok("401 body has error field", body401.error === "Unauthorized");

    const wrongAuth = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health", {
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
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health"),
    );
    ok("200 when CRON_SECRET is unset", res.status === 200);
  }

  // (3) Auth gate: correct bearer with CRON_SECRET set → 200.
  {
    process.env.CRON_SECRET = "shhh";
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health", {
        headers: { authorization: "Bearer shhh" },
      }),
    );
    ok("200 when CRON_SECRET matches bearer", res.status === 200);
    delete process.env.CRON_SECRET;
  }

  // (4) Empty reports collection → reads reports, finds nothing, no
  //     alert state changes, no users lookup, no email.
  {
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health"),
    );
    ok("empty: 200", res.status === 200);
    const body = await res.json();
    ok("empty: shapesScanned=0", body.shapesScanned === 0);
    ok("empty: firing=0", body.firing === 0);
    ok("empty: newAlerts=0", body.newAlerts === 0);
    ok("empty: emailed=0", body.emailed === 0);
    ok("empty: recovered=[]", Array.isArray(body.recovered) && body.recovered.length === 0);

    const findCols = fake.ops
      .filter((o) => o.op === "find")
      .map((o) => o.collection);
    ok(
      "reads tekmetric_endpoint_reports",
      findCols.includes("tekmetric_endpoint_reports"),
    );
    ok(
      "checks the alerts collection",
      findCols.includes("tekmetric_endpoint_health_alerts"),
    );
    ok(
      "skips users lookup when nothing fires",
      !findCols.includes("users"),
    );
    ok("no email sent", sent.length === 0);
  }

  // (5) Below-threshold noise: one fully-failing shop is not enough to
  //     fire (default threshold is 3 distinct shops), and total volume
  //     is below the global-rate min-samples floor.
  {
    const fake = makeFakeDb({
      tekmetric_endpoint_reports: [
        ...reps("/api/v1/customers", 1, 5, true), // one shop fully failing
        ...reps("/api/v1/customers", 2, 5, false),
        ...reps("/api/v1/customers", 3, 5, false),
      ],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health"),
    );
    const body = await res.json();
    ok("sub-threshold: 200", res.status === 200);
    ok("sub-threshold: shapesScanned=1", body.shapesScanned === 1);
    ok("sub-threshold: firing=0", body.firing === 0);
    ok("sub-threshold: newAlerts=0", body.newAlerts === 0);
    ok("sub-threshold: no email sent", sent.length === 0);
    ok(
      "sub-threshold: no dedup row inserted",
      fake.collections.tekmetric_endpoint_health_alerts == null ||
        fake.collections.tekmetric_endpoint_health_alerts.length === 0,
    );
  }

  // (6) Fully-failing-shops trigger: 3 distinct shops are each fully
  //     failing for the same endpointShape → fires, dedup row inserted,
  //     each platform admin gets a single email naming the shape.
  {
    const fake = makeFakeDb({
      tekmetric_endpoint_reports: [
        ...reps("/api/v1/repair-orders", 1, 5, true),
        ...reps("/api/v1/repair-orders", 2, 5, true),
        ...reps("/api/v1/repair-orders", 3, 5, true),
        // An unrelated, healthy shape — must not fire.
        ...reps("/api/v1/customers", 1, 10, false),
      ],
      users: [
        { email: "ops1@example.com", isPlatformAdmin: true },
        { email: "ops2@example.com", isPlatformAdmin: true },
        { email: "shop-owner@example.com", isPlatformAdmin: false },
      ],
      tekmetric_endpoint_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health"),
    );
    const body = await res.json();
    ok("fleet: 200", res.status === 200);
    ok("fleet: firing=1", body.firing === 1);
    ok("fleet: newAlerts=1", body.newAlerts === 1);
    ok("fleet: alreadyFiring=0", body.alreadyFiring === 0);
    ok(
      "fleet: firing shape is the regressed RO endpoint",
      body.firingShapes?.[0]?.endpointShape === "/api/v1/repair-orders",
    );
    ok(
      "fleet: trigger reason mentions fully-failing-shop count",
      body.firingShapes?.[0]?.fullyFailingShops === 3 &&
        body.firingShapes?.[0]?.reasons?.some((r: string) =>
          r.includes("fully failing"),
        ),
    );
    ok(
      "fleet: affectedShops names the three shops",
      body.firingShapes?.[0]?.affectedShops?.length === 3,
    );

    // Dedup row inserted with the right shape.
    const inserts = fake.ops.filter(
      (o) =>
        o.op === "insertOne" &&
        o.collection === "tekmetric_endpoint_health_alerts",
    );
    ok("inserts exactly one alert row", inserts.length === 1);
    const insertedDoc = (inserts[0] as any).doc;
    ok(
      "alert row keyed by endpointShape",
      insertedDoc.endpointShape === "/api/v1/repair-orders",
    );
    ok("alert row carries firstFiredAt Date", insertedDoc.firstFiredAt instanceof Date);
    ok("alert row carries fullyFailingShops=3", insertedDoc.fullyFailingShops === 3);

    // Unique index defensively created.
    ok(
      "creates unique index on endpointShape",
      fake.ops.some(
        (o) =>
          o.op === "createIndex" &&
          o.collection === "tekmetric_endpoint_health_alerts" &&
          (o as any).spec?.endpointShape === 1 &&
          (o as any).opts?.unique === true,
      ),
    );

    // Email assertions: one per platform admin only, correct subject
    // and HTML body naming the regressed shape.
    ok("sendEmail called once per platform admin", sent.length === 2);
    const recipients = sent.map((s) => s.to).sort();
    assert.deepEqual(recipients, ["ops1@example.com", "ops2@example.com"]);
    for (const email of sent) {
      ok(
        `subject names firing-shape count for ${email.to}`,
        email.subject === "[MOS] Tekmetric endpoint outage: 1 shape(s) firing",
      );
      ok(
        `html names the regressed shape for ${email.to}`,
        typeof email.html === "string" &&
          email.html.includes("/api/v1/repair-orders"),
      );
      ok(
        `html cites the cron route for ${email.to}`,
        typeof email.html === "string" &&
          email.html.includes("/api/cron/tekmetric-endpoint-health"),
      );
    }
  }

  // (7) Global-error-rate trigger: no individual shop is fully failing,
  //     but enough of the fleet is erroring out that the global rate
  //     crosses 50% with at least 20 samples → fires.
  {
    const fake = makeFakeDb({
      tekmetric_endpoint_reports: [
        // Shop 1: 8 errors, 2 successes (80% — but only 10 samples for
        // this shop, doesn't matter, it's the global tally we care
        // about and shop is not at 100%).
        ...reps("/api/v1/jobs", 1, 8, true),
        ...reps("/api/v1/jobs", 1, 2, false),
        // Shop 2: 7 errors, 3 successes (70%).
        ...reps("/api/v1/jobs", 2, 7, true),
        ...reps("/api/v1/jobs", 2, 3, false),
        // Total: 15 errors / 25 calls = 60%, 25 >= 20 → fires globally.
        ...reps("/api/v1/jobs", 3, 0, true),
        ...reps("/api/v1/jobs", 3, 5, false),
      ],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      tekmetric_endpoint_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health"),
    );
    const body = await res.json();
    ok("global-rate: 200", res.status === 200);
    ok("global-rate: firing=1", body.firing === 1);
    ok(
      "global-rate: trigger reason mentions global error rate",
      body.firingShapes?.[0]?.reasons?.some((r: string) =>
        r.includes("global error rate"),
      ),
    );
    ok(
      "global-rate: no individual shop is fully failing",
      body.firingShapes?.[0]?.fullyFailingShops === 0,
    );
    ok("global-rate: emailed=1", body.emailed === 1);
  }

  // (8) Idempotency: re-running the cron with the dedup row already in
  //     place → still firing in the response, but no insert and no
  //     email.
  {
    const fake = makeFakeDb({
      tekmetric_endpoint_reports: [
        ...reps("/api/v1/repair-orders", 1, 5, true),
        ...reps("/api/v1/repair-orders", 2, 5, true),
        ...reps("/api/v1/repair-orders", 3, 5, true),
      ],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      tekmetric_endpoint_health_alerts: [
        {
          endpointShape: "/api/v1/repair-orders",
          firstFiredAt: new Date(),
          reasons: ["3 shops fully failing (>= 3)"],
          fullyFailingShops: 3,
          totalRequests: 15,
          totalErrors: 15,
          errorRate: 1,
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health"),
    );
    const body = await res.json();
    ok("dedup: 200", res.status === 200);
    ok("dedup: firing=1 (still flagged)", body.firing === 1);
    ok("dedup: newAlerts=0", body.newAlerts === 0);
    ok("dedup: alreadyFiring=1", body.alreadyFiring === 1);
    ok("dedup: emailed=0", body.emailed === 0);
    ok("dedup: no email sent", sent.length === 0);
    ok(
      "dedup: alert collection unchanged (still one row)",
      fake.collections.tekmetric_endpoint_health_alerts.length === 1,
    );
    ok(
      "dedup: skips users lookup when nothing newly fires",
      !fake.ops.some((o) => o.op === "find" && o.collection === "users"),
    );
  }

  // (9) Recovery: a previously-firing shape is no longer firing → its
  //     dedup row is deleted so the next outage repages, and no email
  //     is sent for the recovery itself.
  {
    const fake = makeFakeDb({
      tekmetric_endpoint_reports: [
        // Healthy now — only successes for the previously-firing shape.
        ...reps("/api/v1/repair-orders", 1, 5, false),
        ...reps("/api/v1/repair-orders", 2, 5, false),
      ],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      tekmetric_endpoint_health_alerts: [
        {
          endpointShape: "/api/v1/repair-orders",
          firstFiredAt: new Date(),
          reasons: ["3 shops fully failing (>= 3)"],
          fullyFailingShops: 3,
          totalRequests: 15,
          totalErrors: 15,
          errorRate: 1,
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health"),
    );
    const body = await res.json();
    ok("recovery: 200", res.status === 200);
    ok("recovery: firing=0", body.firing === 0);
    ok("recovery: newAlerts=0", body.newAlerts === 0);
    ok(
      "recovery: recovered list names the shape",
      Array.isArray(body.recovered) &&
        body.recovered.length === 1 &&
        body.recovered[0] === "/api/v1/repair-orders",
    );
    ok("recovery: no email sent", sent.length === 0);
    ok(
      "recovery: dedup row deleted",
      fake.collections.tekmetric_endpoint_health_alerts.length === 0,
    );
    ok(
      "recovery: deleteMany targeted the recovered shape",
      fake.ops.some(
        (o) =>
          o.op === "deleteMany" &&
          o.collection === "tekmetric_endpoint_health_alerts" &&
          (o as any).filter?.endpointShape?.$in?.includes(
            "/api/v1/repair-orders",
          ),
      ),
    );
  }

  // (10) Stale reports outside the rolling window must NOT count → the
  //      shape stays healthy.
  {
    const fake = makeFakeDb({
      tekmetric_endpoint_reports: [
        // 90 minutes ago — outside the 30-minute window.
        rep("/api/v1/customers", 1, true, 90),
        rep("/api/v1/customers", 2, true, 90),
        rep("/api/v1/customers", 3, true, 90),
        rep("/api/v1/customers", 1, true, 90),
        rep("/api/v1/customers", 2, true, 90),
        rep("/api/v1/customers", 3, true, 90),
      ],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      tekmetric_endpoint_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health"),
    );
    const body = await res.json();
    ok("stale: 200", res.status === 200);
    ok("stale: firing=0 (outside window)", body.firing === 0);
    ok("stale: emailed=0", body.emailed === 0);
  }

  // (11) Per-shop noise floor: a "shop" with only 2 errored calls does
  //      NOT count as fully failing — needs at least 3 samples — so
  //      three shops with 2 errors each should NOT trip the
  //      fully-failing-shops trigger on its own.
  {
    const fake = makeFakeDb({
      tekmetric_endpoint_reports: [
        ...reps("/api/v1/customers", 1, 2, true),
        ...reps("/api/v1/customers", 2, 2, true),
        ...reps("/api/v1/customers", 3, 2, true),
      ],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      tekmetric_endpoint_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health"),
    );
    const body = await res.json();
    ok("noise-floor: 200", res.status === 200);
    ok(
      "noise-floor: no shape fires (per-shop sample floor enforced)",
      body.firing === 0,
    );
    ok("noise-floor: emailed=0", body.emailed === 0);
  }

  // (12) Newly-firing alert with no platform admins configured → dedup
  //      row is still inserted (state preserved), but no email fan-out.
  {
    const fake = makeFakeDb({
      tekmetric_endpoint_reports: [
        ...reps("/api/v1/repair-orders", 1, 5, true),
        ...reps("/api/v1/repair-orders", 2, 5, true),
        ...reps("/api/v1/repair-orders", 3, 5, true),
      ],
      users: [],
      tekmetric_endpoint_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-endpoint-health"),
    );
    const body = await res.json();
    ok("no-admins: 200", res.status === 200);
    ok("no-admins: newAlerts=1", body.newAlerts === 1);
    ok("no-admins: emailed=0", body.emailed === 0);
    ok("no-admins: no email sent", sent.length === 0);
    ok(
      "no-admins: dedup row was still inserted",
      fake.collections.tekmetric_endpoint_health_alerts.length === 1,
    );
  }

  Object.assign(__deps, ORIGINAL_DEPS);

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll tekmetric-endpoint-health route smoke assertions passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
