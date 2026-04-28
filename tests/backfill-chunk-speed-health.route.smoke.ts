/**
 * Route-level smoke test for the backfill chunk-speed alerter.
 *
 * Run: `npx tsx tests/backfill-chunk-speed-health.route.smoke.ts`
 *
 * The companion `backfill-chunk-speed-health.smoke.ts` covers the pure
 * threshold / dedup logic in `./lib`. This test exercises the end-to-end
 * route handler in `route.ts` itself — auth gate, the right Mongo
 * collections being queried, alert rows being upserted/deleted, and the
 * email payload (subject + HTML) actually sent for each platform admin.
 *
 * `getDb` and `sendEmail` are swapped out via the route's `__deps` test
 * seam, so this runs without a real DB or network.
 */

import assert from "node:assert/strict";

import { NextRequest } from "next/server";
import {
  HIGH_BACKOFF_AVG_MS,
  MIN_CHUNK_SAMPLES,
  PROVIDERS,
  SLOW_P95_THRESHOLD_MS,
} from "../app/api/cron/backfill-chunk-speed-health/lib";
import {
  GET,
  __deps,
} from "../app/api/cron/backfill-chunk-speed-health/route";
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

// ------------------------------------------------------------------
// Test helpers
// ------------------------------------------------------------------

function chunks(
  count: number,
  override: Partial<{
    durationMs: number;
    backoff429Ms: number;
    jobsCacheHits: number;
    jobsCacheMisses: number;
    vehiclesCacheHits: number;
    vehiclesCacheMisses: number;
    customersCacheHits: number;
    customersCacheMisses: number;
  }> = {},
) {
  const base = {
    durationMs: 1000,
    backoff429Ms: 0,
    jobsCacheHits: 90,
    jobsCacheMisses: 10,
    vehiclesCacheHits: 90,
    vehiclesCacheMisses: 10,
    customersCacheHits: 90,
    customersCacheMisses: 10,
    ...override,
  };
  return Array.from({ length: count }, () => ({ ...base }));
}

function progressRow(shopId: number, recentChunkMetrics: any[], completed = false) {
  return { shopId, completed, recentChunkMetrics };
}

const TEKMETRIC_COL = PROVIDERS.find((p) => p.key === "tekmetric")!.collectionName;
const PROTRACTOR_COL = PROVIDERS.find((p) => p.key === "protractor")!.collectionName;
const SHOPWARE_COL = PROVIDERS.find((p) => p.key === "shopware")!.collectionName;

function installFakes(db: any, sentEmails: any[]) {
  __deps.getDb = (async () => db) as any;
  __deps.sendEmail = (async (args: any) => {
    sentEmails.push(args);
    return { ok: true };
  }) as any;
}

// Save the originals so we can restore at end-of-test (defensive — the
// test file is a one-shot runner, but this guards against accidental
// reuse if someone imports it elsewhere).
const ORIGINAL_DEPS = { ...__deps };

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

async function run() {
  console.log("backfill-chunk-speed-health route smoke");

  // (1) Auth gate: CRON_SECRET set, missing/wrong bearer → 401.
  {
    process.env.CRON_SECRET = "shhh";
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);

    const noAuth = await GET(
      new NextRequest("http://localhost/api/cron/backfill-chunk-speed-health"),
    );
    ok("401 when CRON_SECRET set and no Authorization header", noAuth.status === 401);
    const body401 = await noAuth.json();
    ok("401 body has error field", body401.error === "Unauthorized");

    const wrongAuth = await GET(
      new NextRequest("http://localhost/api/cron/backfill-chunk-speed-health", {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    ok("401 when CRON_SECRET set and wrong bearer", wrongAuth.status === 401);

    // No DB or email side effects on the auth-deny path.
    ok(
      "auth deny does not touch the DB",
      fake.ops.length === 0,
      `ops=${JSON.stringify(fake.ops)}`,
    );
    ok("auth deny does not send any email", sent.length === 0);

    delete process.env.CRON_SECRET;
  }

  // (2) Auth gate: when CRON_SECRET unset, requests are allowed.
  {
    delete process.env.CRON_SECRET;
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/backfill-chunk-speed-health"),
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
      new NextRequest("http://localhost/api/cron/backfill-chunk-speed-health", {
        headers: { authorization: "Bearer shhh" },
      }),
    );
    ok("200 when CRON_SECRET matches bearer", res.status === 200);
    delete process.env.CRON_SECRET;
  }

  // (4) Reads the right collections (one per provider) plus shops + alerts.
  // Empty DB → no breachers, no emails, but the route should still issue
  // exactly the read pattern the dashboard relies on.
  {
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/backfill-chunk-speed-health"),
    );
    ok("empty DB → 200", res.status === 200);

    const findCollections = fake.ops
      .filter((o) => o.op === "find")
      .map((o) => o.collection);
    ok(
      "reads all three provider progress collections",
      findCollections.includes(TEKMETRIC_COL) &&
        findCollections.includes(PROTRACTOR_COL) &&
        findCollections.includes(SHOPWARE_COL),
      `findCollections=${JSON.stringify(findCollections)}`,
    );
    ok(
      "reads backfill_chunk_speed_alerts dedup collection",
      findCollections.includes("backfill_chunk_speed_alerts"),
    );
    // No candidate shopIds → shops should not be queried, and no admins
    // are looked up because there's nothing to alert on.
    ok(
      "skips shops lookup when no candidate shopIds",
      !findCollections.includes("shops"),
    );
    ok(
      "skips users lookup when nothing to alert on",
      !findCollections.includes("users"),
    );

    const body = await res.json();
    ok("response body shape: scanned", body.scanned && typeof body.scanned === "object");
    ok("response body shape: emailed=0", body.emailed === 0);
    ok("response body shape: breachingTotal=0", body.breachingTotal === 0);
  }

  // (5) Single new breaching shop → upsert into alerts collection,
  //     send one email per platform admin, with expected subject + HTML.
  {
    const fake = makeFakeDb({
      [TEKMETRIC_COL]: [
        progressRow(
          42,
          chunks(MIN_CHUNK_SAMPLES, { durationMs: SLOW_P95_THRESHOLD_MS + 1 }),
        ),
      ],
      [PROTRACTOR_COL]: [],
      [SHOPWARE_COL]: [],
      shops: [
        { shopId: 42, name: "Acme Auto", locationIdentifier: "ACME-001" },
      ],
      users: [
        { _id: "u1", email: "ops1@example.com", isPlatformAdmin: true },
        { _id: "u2", email: "ops2@example.com", isPlatformAdmin: true },
        { _id: "u3", email: "shop-owner@example.com", isPlatformAdmin: false },
      ],
      backfill_chunk_speed_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/backfill-chunk-speed-health"),
    );
    ok("breaching shop → 200", res.status === 200);

    const body = await res.json();
    ok("response: 1 new alert", body.newAlerts === 1);
    ok("response: 1 breaching", body.breachingTotal === 1);
    ok("response: emailed once per platform admin (2)", body.emailed === 2);

    // Alert row was upserted with provider+shopId+reasonsKey.
    const upsertOps = fake.ops.filter(
      (o) => o.op === "updateOne" && o.collection === "backfill_chunk_speed_alerts",
    );
    ok(
      "upserts exactly one alert row for the new breach",
      upsertOps.length === 1 && (upsertOps[0] as any).opts?.upsert === true,
      `upsertOps=${JSON.stringify(upsertOps)}`,
    );
    const upserted = (upsertOps[0] as any).update.$set;
    ok("upsert: provider=tekmetric", upserted.provider === "tekmetric");
    ok("upsert: shopId=42", upserted.shopId === 42);
    ok("upsert: reasonsKey=slow_p95", upserted.reasonsKey === "slow_p95");
    ok(
      "upsert: reasons array is [slow_p95]",
      Array.isArray(upserted.reasons) &&
        upserted.reasons.length === 1 &&
        upserted.reasons[0] === "slow_p95",
    );
    ok("upsert: firstAlertedAt set", upserted.firstAlertedAt instanceof Date);
    ok("upsert: lastAlertedAt set", upserted.lastAlertedAt instanceof Date);

    // Index is created defensively.
    ok(
      "creates unique index on (provider, shopId)",
      fake.ops.some(
        (o) =>
          o.op === "createIndex" &&
          o.collection === "backfill_chunk_speed_alerts" &&
          (o as any).spec.provider === 1 &&
          (o as any).spec.shopId === 1 &&
          (o as any).opts?.unique === true,
      ),
    );

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

    // Email assertions: one per platform admin, correct subject and HTML.
    ok("sendEmail called once per platform admin", sent.length === 2);
    const recipients = sent.map((s) => s.to).sort();
    assert.deepEqual(recipients, ["ops1@example.com", "ops2@example.com"]);
    ok("recipients are the two platform admins (not the shop owner)", true);

    for (const email of sent) {
      ok(
        `subject names breach count for ${email.to}`,
        email.subject === "[MOS] Backfill chunk-speed: 1 shop(s) breaching (1 total)",
        `subject=${email.subject}`,
      );
      ok(
        `html includes shop display name for ${email.to}`,
        typeof email.html === "string" && email.html.includes("Acme Auto"),
      );
      ok(
        `html includes location identifier for ${email.to}`,
        typeof email.html === "string" && email.html.includes("ACME-001"),
      );
      ok(
        `html includes the shop's MOS id for ${email.to}`,
        typeof email.html === "string" && email.html.includes(">42<"),
      );
      ok(
        `html includes the firing reason for ${email.to}`,
        typeof email.html === "string" && email.html.includes("slow_p95"),
      );
      ok(
        `html flags the row as NEW for ${email.to}`,
        typeof email.html === "string" && email.html.includes("NEW"),
      );
      ok(
        `html links to the platform-admin sync-health page for ${email.to}`,
        typeof email.html === "string" && email.html.includes("/platform-admin/sync-health"),
      );
    }
  }

  // (6) Existing alert with the same reasons → no email re-sent (dedup),
  //     only `lastSeenAt` touched on the existing row.
  {
    const fake = makeFakeDb({
      [TEKMETRIC_COL]: [
        progressRow(
          42,
          chunks(MIN_CHUNK_SAMPLES, { durationMs: SLOW_P95_THRESHOLD_MS + 1 }),
        ),
      ],
      [PROTRACTOR_COL]: [],
      [SHOPWARE_COL]: [],
      shops: [{ shopId: 42, name: "Acme Auto" }],
      users: [{ email: "ops1@example.com", isPlatformAdmin: true }],
      backfill_chunk_speed_alerts: [
        {
          provider: "tekmetric",
          shopId: 42,
          reasonsKey: "slow_p95",
          firstAlertedAt: new Date(Date.now() - 86400000),
          lastAlertedAt: new Date(Date.now() - 86400000),
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/backfill-chunk-speed-health"),
    );
    ok("dedup: 200", res.status === 200);
    const body = await res.json();
    ok("dedup: emailed=0 (already-known breach is suppressed)", body.emailed === 0);
    ok("dedup: newAlerts=0", body.newAlerts === 0);
    ok("dedup: reasonsChangedAlerts=0", body.reasonsChangedAlerts === 0);
    ok("dedup: breachingTotal=1", body.breachingTotal === 1);
    ok("dedup: no email sent", sent.length === 0);

    // The existing row had `lastSeenAt` touched, not `lastAlertedAt`.
    const updateOps = fake.ops.filter(
      (o) => o.op === "updateOne" && o.collection === "backfill_chunk_speed_alerts",
    );
    ok(
      "dedup: exactly one updateOne against alerts collection",
      updateOps.length === 1,
    );
    const updateSet = (updateOps[0] as any).update.$set;
    ok(
      "dedup: only lastSeenAt is set on the existing row",
      updateSet.lastSeenAt instanceof Date &&
        !("lastAlertedAt" in updateSet) &&
        !("firstAlertedAt" in updateSet),
      `update=${JSON.stringify(updateSet)}`,
    );
  }

  // (7) Reasons changed for an existing alert → re-email with REASONS CHANGED.
  {
    const fake = makeFakeDb({
      [TEKMETRIC_COL]: [
        progressRow(
          42,
          chunks(MIN_CHUNK_SAMPLES, {
            durationMs: SLOW_P95_THRESHOLD_MS + 1,
            backoff429Ms: HIGH_BACKOFF_AVG_MS + 1,
          }),
        ),
      ],
      [PROTRACTOR_COL]: [],
      [SHOPWARE_COL]: [],
      shops: [{ shopId: 42, name: "Acme Auto" }],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      backfill_chunk_speed_alerts: [
        {
          provider: "tekmetric",
          shopId: 42,
          reasonsKey: "slow_p95",
          firstAlertedAt: new Date(Date.now() - 86400000),
          lastAlertedAt: new Date(Date.now() - 86400000),
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/backfill-chunk-speed-health"),
    );
    const body = await res.json();
    ok("reasons-changed: 200", res.status === 200);
    ok("reasons-changed: 1 reasonsChangedAlerts", body.reasonsChangedAlerts === 1);
    ok("reasons-changed: 0 newAlerts", body.newAlerts === 0);
    ok("reasons-changed: emailed once", sent.length === 1 && body.emailed === 1);
    ok(
      "reasons-changed: html flags row as REASONS CHANGED",
      sent[0].html.includes("REASONS CHANGED"),
    );
    ok(
      "reasons-changed: html lists both reasons",
      sent[0].html.includes("slow_p95") && sent[0].html.includes("high_backoff"),
    );

    // The dedup row should have its reasonsKey rewritten to the new sorted
    // value, and previousReasonsKey should be captured for the audit trail.
    const updateOps = fake.ops.filter(
      (o) => o.op === "updateOne" && o.collection === "backfill_chunk_speed_alerts",
    );
    ok("reasons-changed: exactly one alerts updateOne", updateOps.length === 1);
    const set = (updateOps[0] as any).update.$set;
    ok(
      "reasons-changed: alerts row reasonsKey updated to sorted new key",
      set.reasonsKey === "high_backoff,slow_p95",
    );
    ok(
      "reasons-changed: previousReasonsKey captured",
      set.previousReasonsKey === "slow_p95",
    );
  }

  // (8) Recovery: previously-alerted Tekmetric shop with a slow_p95
  // reason is no longer breaching → its dedup row is auto-deleted AND a
  // recovery email is sent (Tekmetric-only feature).
  {
    const fake = makeFakeDb({
      [TEKMETRIC_COL]: [progressRow(42, chunks(MIN_CHUNK_SAMPLES))], // healthy
      [PROTRACTOR_COL]: [],
      [SHOPWARE_COL]: [],
      shops: [{ shopId: 42, name: "Acme Auto" }],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      backfill_chunk_speed_alerts: [
        {
          provider: "tekmetric",
          shopId: 42,
          reasonsKey: "slow_p95",
          firstAlertedAt: new Date(Date.now() - 86400000),
          lastAlertedAt: new Date(Date.now() - 86400000),
          lastSeenP95Ms: SLOW_P95_THRESHOLD_MS + 60_000,
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/backfill-chunk-speed-health"),
    );
    const body = await res.json();
    ok("recovery: 200", res.status === 200);
    ok("recovery: emailed=0 (no breach alerts)", body.emailed === 0);
    ok("recovery: 1 resolvedAndCleared", body.resolvedAndCleared === 1);
    ok(
      "recovery: 1 tekmetric recovery captured",
      Array.isArray(body.tekmetricRecoveries) &&
        body.tekmetricRecoveries.length === 1,
    );
    ok("recovery: recoveryEmailed=1", body.recoveryEmailed === 1);

    // Tekmetric slow_p95 recovery sends its own dedicated email — exactly
    // one per platform admin, with a recovery subject and HTML.
    ok("recovery: exactly one recovery email sent", sent.length === 1);
    const recoveryEmail = sent[0];
    ok(
      "recovery: email goes to platform admin",
      recoveryEmail?.to === "ops@example.com",
    );
    ok(
      "recovery: subject names recovered shop",
      typeof recoveryEmail?.subject === "string" &&
        recoveryEmail.subject.includes("recovered") &&
        recoveryEmail.subject.includes("Acme Auto"),
    );
    ok(
      "recovery: html mentions dropped under threshold",
      typeof recoveryEmail?.html === "string" &&
        recoveryEmail.html.includes("dropped back under"),
    );
    ok(
      "recovery: html includes the recovered shop's MOS id",
      recoveryEmail.html.includes("42"),
    );

    // The alert row should be removed via deleteMany with an $or list.
    const deletes = fake.ops.filter(
      (o) => o.op === "deleteMany" && o.collection === "backfill_chunk_speed_alerts",
    );
    ok("recovery: deleteMany issued against alerts", deletes.length === 1);
    const filter = (deletes[0] as any).filter;
    ok(
      "recovery: deleteMany targets the recovered (provider, shopId)",
      Array.isArray(filter.$or) &&
        filter.$or.some(
          (f: any) => f.provider === "tekmetric" && f.shopId === 42,
        ),
    );
    // And the row really did get removed from our in-memory store.
    ok(
      "recovery: alerts collection is empty after deleteMany",
      fake.collections.backfill_chunk_speed_alerts.length === 0,
    );
  }

  // (9) Completed shops are not paged on, even if their (stale) rollup
  // would otherwise breach. Mirrors the `evaluateShop` short-circuit.
  {
    const fake = makeFakeDb({
      [TEKMETRIC_COL]: [
        progressRow(
          42,
          chunks(MIN_CHUNK_SAMPLES, { durationMs: SLOW_P95_THRESHOLD_MS * 5 }),
          true /* completed */,
        ),
      ],
      [PROTRACTOR_COL]: [],
      [SHOPWARE_COL]: [],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      backfill_chunk_speed_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/backfill-chunk-speed-health"),
    );
    const body = await res.json();
    ok("completed shop: 200", res.status === 200);
    ok("completed shop: not counted as breaching", body.breachingTotal === 0);
    ok("completed shop: no email sent", sent.length === 0);
  }

  // (10) Breaching shop but no platform admins configured → no email,
  //      but the alert row is still upserted so we don't lose state and
  //      so the next admin added gets paged correctly thereafter.
  {
    const fake = makeFakeDb({
      [TEKMETRIC_COL]: [
        progressRow(
          7,
          chunks(MIN_CHUNK_SAMPLES, { durationMs: SLOW_P95_THRESHOLD_MS + 1 }),
        ),
      ],
      [PROTRACTOR_COL]: [],
      [SHOPWARE_COL]: [],
      shops: [{ shopId: 7, name: "Lonely Shop" }],
      users: [], // no platform admins
      backfill_chunk_speed_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/backfill-chunk-speed-health"),
    );
    const body = await res.json();
    ok("no-admins: 200", res.status === 200);
    ok("no-admins: emailed=0", body.emailed === 0);
    ok("no-admins: newAlerts=1 (state still recorded)", body.newAlerts === 1);
    ok("no-admins: no email sent", sent.length === 0);
    ok(
      "no-admins: alerts row was still upserted",
      fake.collections.backfill_chunk_speed_alerts.length === 1,
    );
  }

  // Restore originals before exiting.
  __deps.getDb = ORIGINAL_DEPS.getDb;
  __deps.sendEmail = ORIGINAL_DEPS.sendEmail;

  if (failed > 0) {
    console.error(`\nFAILED ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll route smoke checks passed.");
}

run().catch((err) => {
  console.error("route smoke test crashed:", err);
  process.exit(2);
});
