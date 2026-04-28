/**
 * Route-level smoke test for the Tekmetric backfill health cron.
 *
 * Run: `npx tsx tests/tekmetric-backfill-health.route.smoke.ts`
 *
 * Mirrors the pattern in `tests/backfill-chunk-speed-health.route.smoke.ts`:
 * exercises the auth gate, the right Mongo collections being read,
 * alert-row upserts/deletes, and the email payload (subject + HTML)
 * actually sent for each platform admin via the `__deps` test seam on
 * `route.ts`. No real Mongo / Resend involvement.
 *
 * The tekmetric route has two independent alert tracks worth covering:
 *   - "stuck shop" alerts in `tekmetric_backfill_health_alerts` (state-
 *     based dedup, auto-clear when no longer stuck).
 *   - "permanently-failed RO spike" alerts in
 *     `tekmetric_permfailed_ro_alerts` (growth + absolute thresholds, only
 *     re-paged when the count grows beyond the last alert).
 */

import assert from "node:assert/strict";

import { NextRequest } from "next/server";
import {
  GET,
  __deps,
} from "../app/api/cron/tekmetric-backfill-health/route";
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

async function run() {
  console.log("tekmetric-backfill-health route smoke");

  // (1) Auth gate: CRON_SECRET set, missing/wrong bearer → 401, no DB or
  //     email side effects on the deny path.
  {
    process.env.CRON_SECRET = "shhh";
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);

    const noAuth = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-backfill-health"),
    );
    ok("401 when CRON_SECRET set and no Authorization header", noAuth.status === 401);
    const body401 = await noAuth.json();
    ok("401 body has error field", body401.error === "Unauthorized");

    const wrongAuth = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-backfill-health", {
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
      new NextRequest("http://localhost/api/cron/tekmetric-backfill-health"),
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
      new NextRequest("http://localhost/api/cron/tekmetric-backfill-health", {
        headers: { authorization: "Bearer shhh" },
      }),
    );
    ok("200 when CRON_SECRET matches bearer", res.status === 200);
    delete process.env.CRON_SECRET;
  }

  // (4) Empty DB → reads the right collections, no alerts, no emails.
  {
    const fake = makeFakeDb({});
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-backfill-health"),
    );
    ok("empty DB → 200", res.status === 200);

    const findCollections = fake.ops
      .filter((o) => o.op === "find")
      .map((o) => o.collection);
    ok(
      "reads tekmetric_backfill_progress",
      findCollections.includes("tekmetric_backfill_progress"),
      `findCollections=${JSON.stringify(findCollections)}`,
    );
    ok(
      "reads tekmetric_backfill_health_alerts dedup collection",
      findCollections.includes("tekmetric_backfill_health_alerts"),
    );
    // No stuck shops → users isn't queried (the stuck-shop email branch
    // is short-circuited). The shops lookup itself is always issued (with
    // an empty $in list when there are no candidates), so we don't assert
    // on its absence.
    ok(
      "skips users lookup when nothing to alert on",
      !findCollections.includes("users"),
    );

    const body = await res.json();
    ok("response: scanned=0", body.scanned === 0);
    ok("response: stuckTotal=0", body.stuckTotal === 0);
    ok("response: emailed=0", body.emailed === 0);
    ok("response: permFailedAlerts is empty array",
       Array.isArray(body.permFailedAlerts) && body.permFailedAlerts.length === 0);
    ok("response: permFailedEmailed=0", body.permFailedEmailed === 0);
  }

  // (5) Single new stuck shop → upsert into alerts collection,
  //     send one email per platform admin, with expected subject + HTML.
  {
    const now = Date.now();
    const fake = makeFakeDb({
      tekmetric_backfill_progress: [
        {
          shopId: 42,
          completed: false,
          // 100h ago → stale_run (>48h) AND frozen_cursor (>3d).
          lastRunAt: new Date(now - 100 * HOUR_MS),
          lastCursorMoveAt: new Date(now - 100 * HOUR_MS),
          lastError: null,
        },
      ],
      shops: [
        { shopId: 42, name: "Acme Auto", locationIdentifier: "ACME-001" },
      ],
      users: [
        { _id: "u1", email: "ops1@example.com", isPlatformAdmin: true },
        { _id: "u2", email: "ops2@example.com", isPlatformAdmin: true },
        { _id: "u3", email: "shop-owner@example.com", isPlatformAdmin: false },
      ],
      tekmetric_backfill_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-backfill-health"),
    );
    ok("stuck shop → 200", res.status === 200);

    const body = await res.json();
    ok("response: stuckTotal=1", body.stuckTotal === 1);
    ok("response: 1 newAlerts", body.newAlerts === 1);
    ok("response: emailed once per platform admin (2)", body.emailed === 2);

    // Alert row was upserted with shopId + reasonsKey.
    const upsertOps = fake.ops.filter(
      (o) => o.op === "updateOne" && o.collection === "tekmetric_backfill_health_alerts",
    );
    ok(
      "upserts exactly one stuck-alert row for the new breach",
      upsertOps.length === 1 && (upsertOps[0] as any).opts?.upsert === true,
      `upsertOps=${JSON.stringify(upsertOps)}`,
    );
    const upserted = (upsertOps[0] as any).update.$set;
    ok("upsert: shopId=42", upserted.shopId === 42);
    ok(
      "upsert: reasonsKey is sorted reasons joined",
      upserted.reasonsKey === "frozen_cursor,stale_run",
      `reasonsKey=${upserted.reasonsKey}`,
    );
    ok(
      "upsert: reasons array contains stale_run and frozen_cursor",
      Array.isArray(upserted.reasons) &&
        upserted.reasons.includes("stale_run") &&
        upserted.reasons.includes("frozen_cursor"),
    );
    ok("upsert: firstAlertedAt set", upserted.firstAlertedAt instanceof Date);
    ok("upsert: lastAlertedAt set", upserted.lastAlertedAt instanceof Date);

    // Index is created defensively.
    ok(
      "creates unique index on (shopId) for stuck alerts",
      fake.ops.some(
        (o) =>
          o.op === "createIndex" &&
          o.collection === "tekmetric_backfill_health_alerts" &&
          (o as any).spec.shopId === 1 &&
          (o as any).opts?.unique === true,
      ),
    );

    // Users lookup filters to platform admins with an email.
    const usersFinds = fake.ops.filter(
      (o) => o.op === "find" && o.collection === "users",
    );
    ok("queries users collection at least once", usersFinds.length >= 1);
    const usersFilter = (usersFinds[0] as any).filter;
    ok(
      "users filter: isPlatformAdmin=true",
      usersFilter?.isPlatformAdmin === true,
    );
    ok(
      "users filter: requires non-null email",
      usersFilter?.email && usersFilter.email.$exists === true && usersFilter.email.$ne === null,
    );

    // Shops lookup uses $in over the candidate shopIds.
    const shopsFinds = fake.ops.filter(
      (o) => o.op === "find" && o.collection === "shops",
    );
    ok("queries shops collection once", shopsFinds.length === 1);
    const shopsFilter = (shopsFinds[0] as any).filter;
    ok(
      "shops filter uses $in on shopId with the candidate shop",
      Array.isArray(shopsFilter?.shopId?.$in) &&
        shopsFilter.shopId.$in.includes(42),
    );

    // Email assertions: one per platform admin, correct subject + HTML.
    ok("sendEmail called once per platform admin", sent.length === 2);
    const recipients = sent.map((s) => s.to).sort();
    assert.deepEqual(recipients, ["ops1@example.com", "ops2@example.com"]);
    ok("recipients are the two platform admins (not the shop owner)", true);

    for (const email of sent) {
      ok(
        `subject names stuck count for ${email.to}`,
        email.subject === "[MOS] Tekmetric backfill stuck: 1 shop(s) (1 total)",
        `subject=${email.subject}`,
      );
      ok(
        `html includes shop display name (with locationIdentifier) for ${email.to}`,
        typeof email.html === "string" &&
          email.html.includes("Acme Auto") &&
          email.html.includes("ACME-001"),
      );
      ok(
        `html includes the shop's MOS id for ${email.to}`,
        typeof email.html === "string" && email.html.includes(">42<"),
      );
      ok(
        `html includes the firing reason for ${email.to}`,
        typeof email.html === "string" &&
          email.html.includes("stale_run") &&
          email.html.includes("frozen_cursor"),
      );
      ok(
        `html flags the row as NEW for ${email.to}`,
        typeof email.html === "string" && email.html.includes("NEW"),
      );
    }
  }

  // (6) Existing alert with the same reasons → no email re-sent (dedup),
  //     only `lastSeenAt` touched on the existing row.
  {
    const now = Date.now();
    const fake = makeFakeDb({
      tekmetric_backfill_progress: [
        {
          shopId: 42,
          completed: false,
          lastRunAt: new Date(now - 100 * HOUR_MS),
          lastCursorMoveAt: new Date(now - 100 * HOUR_MS),
          lastError: null,
        },
      ],
      shops: [{ shopId: 42, name: "Acme Auto" }],
      users: [{ email: "ops1@example.com", isPlatformAdmin: true }],
      tekmetric_backfill_health_alerts: [
        {
          shopId: 42,
          reasonsKey: "frozen_cursor,stale_run",
          firstAlertedAt: new Date(now - DAY_MS),
          lastAlertedAt: new Date(now - DAY_MS),
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-backfill-health"),
    );
    ok("dedup: 200", res.status === 200);
    const body = await res.json();
    ok("dedup: emailed=0 (already-known stuck shop is suppressed)", body.emailed === 0);
    ok("dedup: newAlerts=0", body.newAlerts === 0);
    ok("dedup: reasonsChangedAlerts=0", body.reasonsChangedAlerts === 0);
    ok("dedup: stuckTotal=1", body.stuckTotal === 1);
    ok("dedup: no email sent", sent.length === 0);

    // The existing row had `lastSeenAt` touched, not `lastAlertedAt`.
    const updateOps = fake.ops.filter(
      (o) =>
        o.op === "updateOne" &&
        o.collection === "tekmetric_backfill_health_alerts",
    );
    ok(
      "dedup: exactly one updateOne against stuck-alerts collection",
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
    const now = Date.now();
    const fake = makeFakeDb({
      tekmetric_backfill_progress: [
        {
          shopId: 42,
          completed: false,
          lastRunAt: new Date(now - 100 * HOUR_MS),
          lastCursorMoveAt: new Date(now - 100 * HOUR_MS),
          // Now also has a persistent error.
          lastError: "boom",
          lastErrorAt: new Date(now - 48 * HOUR_MS),
        },
      ],
      shops: [{ shopId: 42, name: "Acme Auto" }],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      tekmetric_backfill_health_alerts: [
        {
          shopId: 42,
          reasonsKey: "frozen_cursor,stale_run",
          firstAlertedAt: new Date(now - DAY_MS),
          lastAlertedAt: new Date(now - DAY_MS),
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-backfill-health"),
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
      "reasons-changed: html lists the new reasons (last_error, persistent_error)",
      sent[0].html.includes("last_error") && sent[0].html.includes("persistent_error"),
    );

    // The dedup row should have its reasonsKey rewritten to the new sorted
    // value, and previousReasonsKey should be captured for the audit trail.
    const updateOps = fake.ops.filter(
      (o) =>
        o.op === "updateOne" &&
        o.collection === "tekmetric_backfill_health_alerts",
    );
    ok(
      "reasons-changed: exactly one stuck-alerts updateOne",
      updateOps.length === 1,
    );
    const set = (updateOps[0] as any).update.$set;
    ok(
      "reasons-changed: alerts row reasonsKey updated to new sorted key",
      set.reasonsKey ===
        "frozen_cursor,last_error,persistent_error,stale_run",
      `reasonsKey=${set.reasonsKey}`,
    );
    ok(
      "reasons-changed: previousReasonsKey captured",
      set.previousReasonsKey === "frozen_cursor,stale_run",
    );
  }

  // (8) Recovery: previously-alerted shop is no longer stuck → its dedup
  //     row is auto-deleted (no recovery email is sent for the stuck-shop
  //     track — that's a Tekmetric chunk-speed-only feature).
  {
    const now = Date.now();
    const fake = makeFakeDb({
      tekmetric_backfill_progress: [
        {
          shopId: 42,
          completed: false,
          lastRunAt: new Date(now - 1 * HOUR_MS), // recent → not stuck
          lastCursorMoveAt: new Date(now - 1 * HOUR_MS),
          lastError: null,
        },
      ],
      shops: [{ shopId: 42, name: "Acme Auto" }],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      tekmetric_backfill_health_alerts: [
        {
          shopId: 42,
          reasonsKey: "stale_run",
          firstAlertedAt: new Date(now - DAY_MS),
          lastAlertedAt: new Date(now - DAY_MS),
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-backfill-health"),
    );
    const body = await res.json();
    ok("recovery: 200", res.status === 200);
    ok("recovery: stuckTotal=0", body.stuckTotal === 0);
    ok("recovery: emailed=0 (no recovery email for stuck-shop track)", body.emailed === 0);
    ok("recovery: 1 resolvedAndCleared", body.resolvedAndCleared === 1);

    // The alert row should be removed via deleteMany with $in over shopIds.
    const deletes = fake.ops.filter(
      (o) =>
        o.op === "deleteMany" &&
        o.collection === "tekmetric_backfill_health_alerts",
    );
    ok("recovery: deleteMany issued against stuck-alerts", deletes.length === 1);
    const filter = (deletes[0] as any).filter;
    ok(
      "recovery: deleteMany uses $in over the recovered shopIds",
      Array.isArray(filter?.shopId?.$in) && filter.shopId.$in.includes(42),
    );
    ok(
      "recovery: stuck-alerts collection is empty after deleteMany",
      fake.collections.tekmetric_backfill_health_alerts.length === 0,
    );
    ok("recovery: no email sent on the stuck track", sent.length === 0);
  }

  // (9) Stuck shop but no platform admins configured → no email,
  //     but the alert row is still upserted so we don't lose state.
  {
    const now = Date.now();
    const fake = makeFakeDb({
      tekmetric_backfill_progress: [
        {
          shopId: 7,
          completed: false,
          lastRunAt: new Date(now - 100 * HOUR_MS),
          lastCursorMoveAt: new Date(now - 100 * HOUR_MS),
          lastError: null,
        },
      ],
      shops: [{ shopId: 7, name: "Lonely Shop" }],
      users: [], // no platform admins
      tekmetric_backfill_health_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-backfill-health"),
    );
    const body = await res.json();
    ok("no-admins: 200", res.status === 200);
    ok("no-admins: emailed=0", body.emailed === 0);
    ok("no-admins: newAlerts=1 (state still recorded)", body.newAlerts === 1);
    ok("no-admins: no email sent", sent.length === 0);
    ok(
      "no-admins: stuck-alerts row was still upserted",
      fake.collections.tekmetric_backfill_health_alerts.length === 1,
    );
  }

  // (10) Permanently-failed RO spike: absolute threshold breach (count
  //      ≥ 20) on a shop we've never paged for → one perm-failed email per
  //      platform admin, dedup row upserted into tekmetric_permfailed_ro_alerts
  //      with countHistory and alertedRoIds set.
  {
    const now = Date.now();
    const fake = makeFakeDb({
      tekmetric_backfill_progress: [
        {
          shopId: 99,
          // Healthy on the stuck-shop dimensions. We leave `completed:
          // false` so the row counts as a "candidate" for the shops
          // lookup (the route only resolves names for incomplete /
          // errored shops); the lastRunAt is recent so no stale_run /
          // frozen_cursor reasons fire.
          completed: false,
          lastRunAt: new Date(now - 1 * HOUR_MS),
          lastCursorMoveAt: new Date(now - 1 * HOUR_MS),
          lastError: null,
          // ...but a real perm-failed RO problem
          permanentlyFailedRoCount: 25,
          recentSkippedRos: [
            {
              roId: 1001,
              permanentlyFailed: true,
              lastRetryError: "API 500",
              lastRetryAt: new Date(now - 30 * 60 * 1000),
            },
            {
              roId: 1002,
              permanentlyFailed: true,
              lastRetryError: "timeout",
              lastRetryAt: new Date(now - 60 * 60 * 1000),
            },
          ],
        },
      ],
      shops: [{ shopId: 99, name: "Bad Shop" }],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      tekmetric_backfill_health_alerts: [],
      tekmetric_permfailed_ro_alerts: [],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-backfill-health"),
    );
    const body = await res.json();
    ok("permfailed-spike: 200", res.status === 200);
    ok(
      "permfailed-spike: 1 permFailedAlerts captured",
      Array.isArray(body.permFailedAlerts) && body.permFailedAlerts.length === 1,
    );
    ok("permfailed-spike: permFailedEmailed=1", body.permFailedEmailed === 1);

    // Stuck-shop track stayed quiet (the shop is completed and recently run).
    ok("permfailed-spike: no stuck alerts", body.stuckTotal === 0);
    ok("permfailed-spike: no stuck emails", body.emailed === 0);

    // Exactly one perm-failed email per platform admin.
    ok("permfailed-spike: exactly one perm-failed email", sent.length === 1);
    const email = sent[0];
    ok(
      "permfailed-spike: subject names shop count",
      typeof email.subject === "string" &&
        email.subject === "[MOS] Tekmetric perm-failed RO spike: 1 shop(s)",
      `subject=${email.subject}`,
    );
    ok(
      "permfailed-spike: html names the affected shop",
      typeof email.html === "string" && email.html.includes("Bad Shop"),
    );
    ok(
      "permfailed-spike: html shows the perm-failed count",
      typeof email.html === "string" && email.html.includes("25"),
    );
    ok(
      "permfailed-spike: html cites the absolute trigger",
      typeof email.html === "string" && email.html.includes("absolute&gt;=20"),
    );
    ok(
      "permfailed-spike: html lists each new perm-failed RO id",
      typeof email.html === "string" &&
        email.html.includes("1001") &&
        email.html.includes("1002"),
    );

    // Dedup row in tekmetric_permfailed_ro_alerts captures the alerted state.
    ok(
      "permfailed-spike: dedup row was upserted into tekmetric_permfailed_ro_alerts",
      fake.collections.tekmetric_permfailed_ro_alerts.length === 1,
    );
    const dedupRow = fake.collections.tekmetric_permfailed_ro_alerts[0];
    ok("permfailed-spike: dedup row shopId=99", dedupRow.shopId === 99);
    ok(
      "permfailed-spike: dedup row lastAlertedCount=25",
      dedupRow.lastAlertedCount === 25,
    );
    ok(
      "permfailed-spike: dedup row alertedRoIds includes both fired ROs",
      Array.isArray(dedupRow.alertedRoIds) &&
        dedupRow.alertedRoIds.includes(1001) &&
        dedupRow.alertedRoIds.includes(1002),
    );
    ok(
      "permfailed-spike: dedup row countHistory has the current snapshot",
      Array.isArray(dedupRow.countHistory) &&
        dedupRow.countHistory.length === 1 &&
        dedupRow.countHistory[0].count === 25,
    );

    // Unique index is created for the perm-failed alerts collection.
    ok(
      "permfailed-spike: unique index created on (shopId) for perm-failed alerts",
      fake.ops.some(
        (o) =>
          o.op === "createIndex" &&
          o.collection === "tekmetric_permfailed_ro_alerts" &&
          (o as any).spec.shopId === 1 &&
          (o as any).opts?.unique === true,
      ),
    );
  }

  // (11) Permanently-failed RO dedup: count hasn't grown past
  //      lastAlertedCount → no re-page, but countHistory + lastSeen* are
  //      still updated so future growth is computed correctly.
  {
    const now = Date.now();
    const fake = makeFakeDb({
      tekmetric_backfill_progress: [
        {
          shopId: 99,
          completed: true,
          lastRunAt: new Date(now - 1 * HOUR_MS),
          lastCursorMoveAt: new Date(now - 1 * HOUR_MS),
          lastError: null,
          permanentlyFailedRoCount: 25, // unchanged since last alert
          recentSkippedRos: [
            {
              roId: 1001,
              permanentlyFailed: true,
              lastRetryError: "API 500",
              lastRetryAt: new Date(now - 30 * 60 * 1000),
            },
          ],
        },
      ],
      shops: [{ shopId: 99, name: "Bad Shop" }],
      users: [{ email: "ops@example.com", isPlatformAdmin: true }],
      tekmetric_backfill_health_alerts: [],
      tekmetric_permfailed_ro_alerts: [
        {
          shopId: 99,
          lastAlertedCount: 25,
          alertedRoIds: [1001, 1002],
          countHistory: [{ at: new Date(now - DAY_MS), count: 25 }],
          firstAlertedAt: new Date(now - DAY_MS),
          firstSeenAt: new Date(now - DAY_MS),
        },
      ],
    });
    const sent: any[] = [];
    installFakes(fake.db, sent);
    const res = await GET(
      new NextRequest("http://localhost/api/cron/tekmetric-backfill-health"),
    );
    const body = await res.json();
    ok("permfailed-dedup: 200", res.status === 200);
    ok(
      "permfailed-dedup: no new perm-failed alerts (count flat)",
      Array.isArray(body.permFailedAlerts) && body.permFailedAlerts.length === 0,
    );
    ok("permfailed-dedup: permFailedEmailed=0", body.permFailedEmailed === 0);
    ok("permfailed-dedup: no email sent", sent.length === 0);

    // The dedup row's countHistory should have grown by one snapshot.
    const dedupRow = fake.collections.tekmetric_permfailed_ro_alerts[0];
    ok(
      "permfailed-dedup: lastAlertedCount unchanged at 25",
      dedupRow.lastAlertedCount === 25,
    );
    ok(
      "permfailed-dedup: countHistory grew with the new snapshot",
      Array.isArray(dedupRow.countHistory) && dedupRow.countHistory.length === 2,
    );
    ok(
      "permfailed-dedup: lastSeenCount=25",
      dedupRow.lastSeenCount === 25,
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
