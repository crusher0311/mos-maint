import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail } from "@/lib/email";
import {
  insertWebhookHealthAlert,
  listWebhookSubscriptions,
} from "@/lib/data/repositories/tekmetric-ops";

/**
 * Test seam: the route handler dereferences `__deps.getDb` /
 * `__deps.sendEmail` at call time so the route-level smoke test can swap in
 * fakes without spinning up Mongo or Resend. Production callers should
 * never touch this object — it defaults to the real implementations and is
 * only mutated by `tests/tekmetric-webhook-health.route.smoke.ts`.
 */
export const __deps = {
  getDb,
  sendEmail,
  listWebhookSubscriptions,
  insertWebhookHealthAlert,
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step 5 of task #376: thresholds for the latency + receipt-drop alerts.
// Tunable via env so we can dial them up/down without a code deploy.
const P95_LATENCY_MS_THRESHOLD = Number(
  process.env.TEKMETRIC_WEBHOOK_P95_LATENCY_MS || 3000,
);
const P95_LATENCY_MIN_SAMPLES = Number(
  process.env.TEKMETRIC_WEBHOOK_P95_LATENCY_MIN_SAMPLES || 30,
);
// Per-shop receipt drop is "24h count < 50% of (7d / 7)" — i.e. the day's
// volume is less than half the trailing-week daily average. Floor on 7d
// volume so a brand-new shop with sparse traffic doesn't false-page.
const RECEIPT_DROP_RATIO = Number(
  process.env.TEKMETRIC_WEBHOOK_RECEIPT_DROP_RATIO || 0.5,
);
const RECEIPT_DROP_MIN_7D = Number(
  process.env.TEKMETRIC_WEBHOOK_RECEIPT_DROP_MIN_7D || 14,
);

/** Pick a percentile from an unsorted numeric sample. */
function pickPercentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[idx];
}

/**
 * Webhook health monitor — Step 3a of TEKMETRIC_5K_SCALING_PLAN.md, extended
 * by step 5 of task #376.
 *
 * For every Tekmetric-connected shop, this cron:
 *   1. Counts `tekmetric_webhook_logs` events in the last 24h. Shops with zero
 *      events are flagged as silent (the original 3a contract).
 *   2. Compares each shop's last-24h count against its 7-day daily average; a
 *      drop below `TEKMETRIC_WEBHOOK_RECEIPT_DROP_RATIO` (default 50%) — with
 *      a 7d-volume floor to suppress noise — is flagged as a receipt drop.
 *   3. Computes p95 of `handlerDurationMs` over the last hour; if it exceeds
 *      `TEKMETRIC_WEBHOOK_P95_LATENCY_MS` (default 3000ms) with at least
 *      `TEKMETRIC_WEBHOOK_P95_LATENCY_MIN_SAMPLES` samples, a global
 *      latency alert is raised.
 *
 * All three conditions roll up into a single consolidated email to platform
 * admins (one email per cron run, not per shop) so on-call doesn't get paged
 * 12 times when the underlying outage is one shared cause.
 *
 * Idempotent: at most one alert per (shopId, alertDate-UTC) for the silent +
 * receipt-drop conditions via the `tekmetric_webhook_health_alerts`
 * collection. The latency alert dedups on the same collection with a
 * synthetic shopId of 0 so re-running the cron the same day is a no-op.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}` enforced by the
 * scheduler self-fetch.
 */
export async function GET(req: NextRequest) {
  // Match the auth pattern other crons use.
  const auth = req.headers.get("authorization") || "";
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "";
  if (expected && auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await __deps.getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since1h = new Date(Date.now() - 60 * 60 * 1000);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

  // All shops with a configured Tekmetric integration.
  const tekShops = await db.collection("shops").find(
    { "tekmetric.shopId": { $exists: true } },
    { projection: { shopId: 1, name: 1, "tekmetric.shopId": 1 } }
  ).toArray();

  if (tekShops.length === 0) {
    return NextResponse.json({ scanned: 0, silent: 0, alerted: 0, note: "no Tekmetric shops" });
  }

  const tekShopIds = tekShops.map((s: any) => Number(s.tekmetric.shopId)).filter(Boolean);

  // Ensure the time-window scan stays cheap at scale.
  await db.collection("tekmetric_webhook_logs").createIndex(
    { receivedAt: -1 },
    { name: "receivedAt_-1" }
  ).catch(() => {});

  // Per-shop event counts in the 24h window. Webhook payloads use two shapes
  // for shop identification: `data.shopId` (most events) and
  // `data.repairOrder.shopId` (RO events with nested payload). Both are real
  // shop IDs. We deliberately do NOT fall back to `repairOrderId` — it's a
  // different ID space and would misattribute events.
  const eventCounts24h = await db.collection("tekmetric_webhook_logs").aggregate([
    { $match: { receivedAt: { $gte: since } } },
    {
      $project: {
        shopId: {
          $ifNull: ["$data.shopId", "$data.repairOrder.shopId"],
        },
      },
    },
    { $match: { shopId: { $in: tekShopIds } } },
    { $group: { _id: "$shopId", count: { $sum: 1 } } },
  ]).toArray();

  const countByTekShopId24h = new Map<number, number>();
  for (const row of eventCounts24h as Array<{ _id: number; count: number }>) {
    countByTekShopId24h.set(Number(row._id), row.count);
  }

  // Step 5 of task #376: pull the 7d count too so we can compute the
  // per-shop daily-average and detect a >50% drop. Same `$ifNull` shop-id
  // extraction as above so attribution stays consistent.
  const eventCounts7d = await db.collection("tekmetric_webhook_logs").aggregate([
    { $match: { receivedAt: { $gte: since7d } } },
    {
      $project: {
        shopId: {
          $ifNull: ["$data.shopId", "$data.repairOrder.shopId"],
        },
      },
    },
    { $match: { shopId: { $in: tekShopIds } } },
    { $group: { _id: "$shopId", count: { $sum: 1 } } },
  ]).toArray();

  const countByTekShopId7d = new Map<number, number>();
  for (const row of eventCounts7d as Array<{ _id: number; count: number }>) {
    countByTekShopId7d.set(Number(row._id), row.count);
  }

  const silent: Array<{ tekmetricShopId: number; mosShopId: any; name: string; eventsLast24h: number }> = [];
  const drops: Array<{
    tekmetricShopId: number;
    mosShopId: any;
    name: string;
    eventsLast24h: number;
    eventsLast7d: number;
    expectedDailyAverage: number;
  }> = [];
  for (const shop of tekShops as any[]) {
    const tekId = Number(shop.tekmetric.shopId);
    const count24h = countByTekShopId24h.get(tekId) || 0;
    const count7d = countByTekShopId7d.get(tekId) || 0;
    if (count24h === 0) {
      silent.push({
        tekmetricShopId: tekId,
        mosShopId: shop.shopId,
        name: shop.name || "(unnamed)",
        eventsLast24h: 0,
      });
      continue;
    }
    // Receipt-drop check: only fire when the 7d sample is large enough to be
    // a meaningful baseline. Otherwise a brand-new or low-volume shop will
    // false-page. The silent-shop check above already covers "zero today".
    if (count7d >= RECEIPT_DROP_MIN_7D) {
      const expectedDailyAvg = count7d / 7;
      if (count24h < RECEIPT_DROP_RATIO * expectedDailyAvg) {
        drops.push({
          tekmetricShopId: tekId,
          mosShopId: shop.shopId,
          name: shop.name || "(unnamed)",
          eventsLast24h: count24h,
          eventsLast7d: count7d,
          expectedDailyAverage: Math.round(expectedDailyAvg * 10) / 10,
        });
      }
    }
  }

  // Task #569: missing-subscription detection. A shop can be delivering
  // events today (so it's NOT silent) yet still have no managed webhook
  // subscription record — meaning if its portal subscription is ever deleted,
  // nothing will re-create it. We flag shops with no successful subscription
  // record so the fleet stays self-healing.
  //
  // GATED: only meaningful when we're actually managing subscriptions
  // (`TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE=true`). With auto-subscribe OFF (the
  // default), `subscribeShopToTekmetricWebhooks` never persists a row, so
  // EVERY shop would look "missing" — a mass false-positive. Skip entirely
  // until auto-subscribe is on.
  const autoSubscribeEnabled =
    process.env.TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE === "true";
  const missingSubs: Array<{ tekmetricShopId: number; mosShopId: any; name: string }> = [];
  if (autoSubscribeEnabled) {
    const subRows = await __deps.listWebhookSubscriptions(tekShopIds);
    const subscribedOk = new Set<number>();
    for (const row of subRows as any[]) {
      if (row?.lastResult?.ok === true) subscribedOk.add(Number(row.tekmetricShopId));
    }
    for (const shop of tekShops as any[]) {
      const tekId = Number(shop.tekmetric.shopId);
      if (!subscribedOk.has(tekId)) {
        missingSubs.push({
          tekmetricShopId: tekId,
          mosShopId: shop.shopId,
          name: shop.name || "(unnamed)",
        });
      }
    }
  }

  // Step 5 of task #376: latency check. Aggregate handler durations from the
  // last hour and alert if p95 crosses threshold with enough samples to be
  // statistically meaningful. We pull just the field, not whole rows, so this
  // stays cheap even at 5K-shop volume.
  const latencyRows = await db.collection("tekmetric_webhook_logs").find(
    {
      receivedAt: { $gte: since1h },
      handlerDurationMs: { $exists: true, $ne: null },
    },
    { projection: { handlerDurationMs: 1 } } as any
  ).toArray();
  const latencyValues: number[] = [];
  for (const row of latencyRows as Array<{ handlerDurationMs: any }>) {
    const v = Number(row.handlerDurationMs);
    if (Number.isFinite(v)) latencyValues.push(v);
  }
  const latencyP95 =
    latencyValues.length >= P95_LATENCY_MIN_SAMPLES
      ? pickPercentile(latencyValues, 0.95)
      : null;
  const latencyAlertFiring =
    latencyP95 !== null && latencyP95 > P95_LATENCY_MS_THRESHOLD;

  // Filter out shops we've already alerted today (idempotency). The repo
  // preserves the (tekmetricShopId, alertDate) insert-if-absent semantics
  // (Mongo unique-index / PG ON CONFLICT DO NOTHING) behind the cutover flag.
  const toAlertSilent: typeof silent = [];
  for (const s of silent) {
    try {
      const inserted = await __deps.insertWebhookHealthAlert({
        tekmetricShopId: s.tekmetricShopId,
        mosShopId: s.mosShopId,
        alertDate: today,
        alertKind: "silent",
        createdAt: new Date(),
      });
      if (inserted) toAlertSilent.push(s);
    } catch (err: any) {
      console.error(`[TekmetricWebhookHealth] Alert dedup failed for shop ${s.tekmetricShopId}:`, err?.message);
    }
  }

  // Receipt-drop alerts share the same dedup table as the silent alerts, but
  // use a separate synthetic shopId namespace (negative) so a shop can be
  // independently flagged "silent today" and "drop today" without one
  // suppressing the other. (In practice they're mutually exclusive — silent
  // means count24h===0 — but the unique-index contract is what we're guarding.)
  const toAlertDrop: typeof drops = [];
  for (const d of drops) {
    try {
      const inserted = await __deps.insertWebhookHealthAlert({
        tekmetricShopId: -d.tekmetricShopId, // separate namespace from silent
        mosShopId: d.mosShopId,
        alertDate: today,
        alertKind: "drop",
        eventsLast24h: d.eventsLast24h,
        eventsLast7d: d.eventsLast7d,
        expectedDailyAverage: d.expectedDailyAverage,
        createdAt: new Date(),
      });
      if (inserted) toAlertDrop.push(d);
    } catch (err: any) {
      console.error(`[TekmetricWebhookHealth] Drop alert dedup failed for shop ${d.tekmetricShopId}:`, err?.message);
    }
  }

  // Latency alert dedups on a synthetic shopId of 0 so it follows the same
  // (shopId, alertDate) unique-index contract as the per-shop alerts. One
  // latency alert per UTC day across the whole fleet — repeats no-op.
  let latencyAlertNew = false;
  if (latencyAlertFiring) {
    try {
      latencyAlertNew = await __deps.insertWebhookHealthAlert({
        tekmetricShopId: 0,
        mosShopId: null,
        alertDate: today,
        alertKind: "latency",
        latencyP95Ms: latencyP95,
        sampleCount: latencyValues.length,
        thresholdMs: P95_LATENCY_MS_THRESHOLD,
        createdAt: new Date(),
      });
    } catch (err: any) {
      console.error(`[TekmetricWebhookHealth] Latency alert dedup failed:`, err?.message);
    }
  }

  // Task #569: missing-subscription alert dedup. Uses the same
  // (shopId, alertDate) unique-index contract, but a separate synthetic
  // namespace (offset by 1,000,000) so a shop can be independently flagged
  // "missing subscription" without colliding with its silent (+id) or
  // drop (-id) entries on the same day.
  const toAlertMissing: typeof missingSubs = [];
  for (const m of missingSubs) {
    try {
      const inserted = await __deps.insertWebhookHealthAlert({
        tekmetricShopId: m.tekmetricShopId + 1_000_000,
        mosShopId: m.mosShopId,
        alertDate: today,
        alertKind: "missing_subscription",
        createdAt: new Date(),
      });
      if (inserted) toAlertMissing.push(m);
    } catch (err: any) {
      console.error(`[TekmetricWebhookHealth] Missing-subscription alert dedup failed for shop ${m.tekmetricShopId}:`, err?.message);
    }
  }

  // Send a single consolidated email per cron run instead of one-per-shop.
  let emailed = 0;
  const anyNewAlert =
    toAlertSilent.length > 0 ||
    toAlertDrop.length > 0 ||
    toAlertMissing.length > 0 ||
    latencyAlertNew;
  if (anyNewAlert) {
    // Canonical field is `isPlatformAdmin` (see lib/auth.ts) — not `platformAdmin`.
    const admins = await db.collection("users").find(
      { isPlatformAdmin: true, email: { $exists: true, $ne: null } },
      { projection: { email: 1 } }
    ).toArray();

    if (admins.length === 0) {
      console.warn("[TekmetricWebhookHealth] No platform admins configured; alerts logged only");
    } else {
      const sections: string[] = [];

      if (toAlertSilent.length > 0) {
        const rows = toAlertSilent.map(s => `
          <tr>
            <td style="padding:6px 12px;border:1px solid #ddd">${s.name}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${s.tekmetricShopId}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${s.mosShopId}</td>
          </tr>`).join("");
        sections.push(`
          <h3 style="margin-top:24px">Silent shops (zero events in last 24h) — ${toAlertSilent.length}</h3>
          <p>Likely causes: subscription deleted in Tekmetric portal, shop disconnected the integration, or transport-layer issue.</p>
          <table style="border-collapse:collapse;border:1px solid #ddd">
            <thead>
              <tr>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Shop</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Tekmetric ID</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">MOS ID</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`);
      }

      if (toAlertDrop.length > 0) {
        const rows = toAlertDrop.map(d => `
          <tr>
            <td style="padding:6px 12px;border:1px solid #ddd">${d.name}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${d.tekmetricShopId}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${d.mosShopId}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${d.eventsLast24h}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${d.expectedDailyAverage}</td>
          </tr>`).join("");
        sections.push(`
          <h3 style="margin-top:24px">Receipt-rate drop (&lt; ${Math.round(RECEIPT_DROP_RATIO * 100)}% of trailing 7d daily average) — ${toAlertDrop.length}</h3>
          <p>These shops are still delivering some events but at materially lower volume than their own recent baseline. Investigate whether a subset of event types (e.g. <code>RepairOrder.Posted</code>) has stopped firing.</p>
          <table style="border-collapse:collapse;border:1px solid #ddd">
            <thead>
              <tr>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Shop</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Tekmetric ID</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">MOS ID</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Last 24h</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Expected (7d avg)</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`);
      }

      if (toAlertMissing.length > 0) {
        const rows = toAlertMissing.map(m => `
          <tr>
            <td style="padding:6px 12px;border:1px solid #ddd">${m.name}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${m.tekmetricShopId}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${m.mosShopId}</td>
          </tr>`).join("");
        sections.push(`
          <h3 style="margin-top:24px">Missing webhook subscription — ${toAlertMissing.length}</h3>
          <p>These shops have no successful managed webhook subscription on record, so their freshness isn't self-healing — if their portal subscription is deleted, nothing re-creates it. The daily <code>/api/cron/webhook-subscription-sweep</code> will attempt repair; persistent entries here mean auto-subscribe is failing for these shops (check credentials / API errors on <code>/api/platform-admin/tekmetric/webhook-subscription-status</code>).</p>
          <table style="border-collapse:collapse;border:1px solid #ddd">
            <thead>
              <tr>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Shop</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Tekmetric ID</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">MOS ID</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`);
      }

      if (latencyAlertNew && latencyP95 !== null) {
        sections.push(`
          <h3 style="margin-top:24px">Webhook handler latency — p95 = ${latencyP95}ms (threshold ${P95_LATENCY_MS_THRESHOLD}ms)</h3>
          <p>The Tekmetric webhook handler's p95 over the last hour exceeds the alerting threshold (${latencyValues.length} samples). Slow webhooks delay dashboard freshness and risk Tekmetric retries / drops on their side. Check <code>/api/platform-admin/tekmetric/webhook-subscription-status</code> for the trend, and the post-#360 NIS path for inline work that should be deferred.</p>`);
      }

      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
          <h2>Tekmetric Webhook Health — Daily Check</h2>
          ${sections.join("\n")}
          <p style="margin-top:16px;color:#666;font-size:13px">
            Sent by <code>/api/cron/tekmetric-webhook-health</code> · Diagnostic surface:
            <code>/api/platform-admin/tekmetric/webhook-subscription-status</code>
          </p>
        </div>`;

      const subjectParts: string[] = [];
      if (toAlertSilent.length > 0) subjectParts.push(`${toAlertSilent.length} silent`);
      if (toAlertDrop.length > 0) subjectParts.push(`${toAlertDrop.length} drop`);
      if (toAlertMissing.length > 0) subjectParts.push(`${toAlertMissing.length} missing-sub`);
      if (latencyAlertNew) subjectParts.push(`p95=${latencyP95}ms`);
      // Preserve the legacy subject format when only the silent-shop condition
      // fired, so existing email filters/rules in admins' inboxes keep working.
      const subject =
        toAlertSilent.length > 0 && toAlertDrop.length === 0 && toAlertMissing.length === 0 && !latencyAlertNew
          ? `[MOS] Tekmetric webhook silence: ${toAlertSilent.length} shop(s) flagged`
          : `[MOS] Tekmetric webhook health: ${subjectParts.join(", ")}`;

      for (const admin of admins as Array<{ email: string }>) {
        try {
          await __deps.sendEmail({
            to: admin.email,
            subject,
            html,
          });
          emailed++;
        } catch (err: any) {
          console.error(`[TekmetricWebhookHealth] Email send failed for ${admin.email}:`, err?.message);
        }
      }
    }
  }

  console.log(
    `[TekmetricWebhookHealth] Scanned ${tekShops.length} shops, ${silent.length} silent (${toAlertSilent.length} new), ${drops.length} drop (${toAlertDrop.length} new), ${missingSubs.length} missing-sub (${toAlertMissing.length} new, autoSubscribe=${autoSubscribeEnabled}), latencyP95=${latencyP95}ms (firing=${latencyAlertFiring}, new=${latencyAlertNew}), emailed ${emailed} admin(s)`,
  );

  return NextResponse.json({
    scanned: tekShops.length,
    silent: silent.length,
    newAlerts: toAlertSilent.length,
    alreadyAlertedToday: silent.length - toAlertSilent.length,
    emailed,
    silentShops: silent,
    receiptDrops: drops,
    newDropAlerts: toAlertDrop.length,
    autoSubscribeEnabled,
    missingSubscriptions: missingSubs,
    newMissingSubscriptionAlerts: toAlertMissing.length,
    latencyP95Ms: latencyP95,
    latencySamples: latencyValues.length,
    latencyAlertFiring,
    latencyAlertNew,
  });
}
