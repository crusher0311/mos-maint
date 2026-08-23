import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import {
  classifyWebhookCoverage,
  selectPollCadence,
  isWebhookFirstDisabled,
  getSafetyNetPollMs,
} from "@/lib/integrations/tekmetric/webhook-coverage";

export const dynamic = "force-dynamic";

async function isPlatformAdmin(): Promise<boolean> {
  const store = await cookies();
  const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
  if (!sid) return false;

  const db = await getDb();
  const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: new Date() } });
  if (!sess) return false;

  const user = await db.collection("users").findOne({ _id: sess.userId });
  // Canonical field is `isPlatformAdmin` (see lib/auth.ts).
  return user?.isPlatformAdmin === true;
}

/**
 * Compute p50 / p95 / p99 from an unsorted numeric sample.
 * Returns nulls when the sample is empty so the UI can render "—" instead of
 * a misleading 0. Sample is sorted in place — callers shouldn't reuse it.
 *
 * Linear interpolation between samples; the rank-based formula matches what
 * the cron-health alerter uses (lib/cron/scheduler.cjs is timeseries-only,
 * but observability tooling should agree on a single percentile definition).
 */
function percentiles(values: number[]): {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  count: number;
} {
  const n = values.length;
  if (n === 0) return { p50: null, p95: null, p99: null, max: null, count: 0 };
  values.sort((a, b) => a - b);
  const pick = (q: number) => {
    const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
    return values[idx];
  };
  return {
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: values[n - 1],
    count: n,
  };
}

/**
 * Step 3c support endpoint — visibility into Tekmetric webhook subscription
 * health per shop. Doesn't modify subscriptions; surfaces drift so a human
 * (or a future auto-subscribe job) can re-register them.
 *
 * For each Tekmetric-connected shop, reports:
 *   - eventsLast24h / 7d / 30d counts
 *   - lastEventAt timestamp
 *   - eventTypeBreakdown (which event categories are flowing vs silent)
 *
 * Step 2 of task #376 also surfaces:
 *   - Aggregate handler latency p50 / p95 / p99 over 24h + 7d (computed from
 *     `tekmetric_webhook_logs.handlerDurationMs`, persisted by the webhook
 *     route since #376 — older log rows lack the field and are excluded).
 *   - The most recent successful run of the `tekmetric-incremental-sync` cron
 *     so we can see the polling safety net is actually firing on schedule.
 *
 * Pairs with `/api/cron/tekmetric-webhook-health` (the alerter) — this gives
 * humans the drill-down view when an alert fires.
 */
export async function GET(req: NextRequest) {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();

  const tekShops = await db.collection("shops").find(
    { "tekmetric.shopId": { $exists: true } },
    { projection: { shopId: 1, name: 1, "tekmetric.shopId": 1, "tekmetric.lastWebhookEventAt": 1, "tekmetric.lastSyncCursor": 1 } }
  ).toArray();

  const tekShopIds = tekShops.map((s: any) => Number(s.tekmetric.shopId)).filter(Boolean);

  await db.collection("tekmetric_webhook_logs").createIndex(
    { receivedAt: -1 },
    { name: "receivedAt_-1" }
  ).catch(() => {});

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Pull every webhook in the last 30 days, grouped by (shopId, eventType, bucket).
  // Same shop-ID-extraction rule as the health cron: only real shop fields,
  // never fall back to `repairOrderId` (different ID space).
  const rows = await db.collection("tekmetric_webhook_logs").aggregate([
    { $match: { receivedAt: { $gte: since30d } } },
    {
      $project: {
        eventType: 1,
        receivedAt: 1,
        shopId: {
          $ifNull: ["$data.shopId", "$data.repairOrder.shopId"],
        },
      },
    },
    { $match: { shopId: { $in: tekShopIds } } },
    {
      $group: {
        _id: { shopId: "$shopId", eventType: "$eventType" },
        count: { $sum: 1 },
        last: { $max: "$receivedAt" },
        last24h: { $sum: { $cond: [{ $gte: ["$receivedAt", since24h] }, 1, 0] } },
        last7d: { $sum: { $cond: [{ $gte: ["$receivedAt", since7d] }, 1, 0] } },
      },
    },
    {
      $group: {
        _id: "$_id.shopId",
        totalLast30d: { $sum: "$count" },
        totalLast7d: { $sum: "$last7d" },
        totalLast24h: { $sum: "$last24h" },
        lastEventAt: { $max: "$last" },
        eventTypeBreakdown: {
          $push: {
            eventType: "$_id.eventType",
            count: "$count",
            last24h: "$last24h",
            last7d: "$last7d",
            lastSeen: "$last",
          },
        },
      },
    },
  ]).toArray();

  const byShop = new Map<number, any>();
  for (const r of rows as any[]) byShop.set(Number(r._id), r);

  // Step 2 of task #376: latency percentiles. Pulls handlerDurationMs samples
  // from the last 7 days in one pass, partitions in JS into 24h vs 7d windows,
  // and computes p50/p95/p99 per window. JS-side sort scales to ~50k samples
  // (typical 7d volume at 5K shops) — well within memory budget. Skipping the
  // fancier `$bucket` / `$percentile` operators keeps this readable and works
  // on any Mongo server version.
  const latencySamples = await db.collection("tekmetric_webhook_logs").find(
    {
      receivedAt: { $gte: since7d },
      handlerDurationMs: { $exists: true, $ne: null },
    },
    { projection: { handlerDurationMs: 1, receivedAt: 1 } }
  ).toArray();
  const samples24h: number[] = [];
  const samples7d: number[] = [];
  for (const row of latencySamples as unknown as Array<{ handlerDurationMs: number; receivedAt: Date }>) {
    const ms = Number(row.handlerDurationMs);
    if (!Number.isFinite(ms)) continue;
    samples7d.push(ms);
    const ts = row.receivedAt instanceof Date ? row.receivedAt.getTime() : Date.parse(row.receivedAt as any);
    if (Number.isFinite(ts) && ts >= since24h.getTime()) samples24h.push(ms);
  }
  const latency = {
    last24h: percentiles(samples24h),
    last7d: percentiles(samples7d),
    note:
      samples7d.length === 0
        ? "no handlerDurationMs samples yet — webhook route stamps it on every receipt going forward (task #376)"
        : null,
  };

  // 3c: surface latest auto-subscribe outcome alongside event health so a human
  // can see "subscription registered OK on date X but events stopped on date Y".
  const subRows = await db.collection("tekmetric_webhook_subscriptions").find(
    { tekmetricShopId: { $in: tekShopIds } },
    { projection: { tekmetricShopId: 1, lastResult: 1, lastAttemptAt: 1, firstAttemptAt: 1, events: 1 } }
  ).toArray();
  const subByShop = new Map<number, any>();
  for (const s of subRows as any[]) subByShop.set(Number(s.tekmetricShopId), s);

  // Step 4 of task #376: surface the polling safety-net cron's last successful
  // run. The cron scheduler writes to the "mos" Mongo db (lib/cron/scheduler.cjs
  // hard-codes that name), separate from the default MOS app db this route
  // otherwise reads. A failed connection here shouldn't break the webhook
  // status response — fall back to null so the UI can render "unknown".
  let incrementalSync: {
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastDurationMs: number | null;
    schedule: string;
  } = {
    lastRunAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    schedule: "*/30 * * * *",
  };
  try {
    // Read from `cron_status` (the same status doc the cron-status admin
    // endpoint and the cron-health-alerter use) instead of the `cron_runs`
    // time-series collection. `cron_runs` is missing fleet-wide in prod
    // (task #449 / diagnosis #443), so the previous lookup always returned
    // null and the Tekmetric webhook view rendered "polling: never" even
    // when the safety-net cron was running every 30 min. Task #458.
    const cronDb = await getDb("mos");
    const statusDoc = await cronDb
      .collection("cron_status")
      .findOne({ _id: "global" as any });
    const lastRun = (statusDoc as any)?.lastRuns?.[
      "tekmetric-incremental-sync"
    ] as { dt?: Date | string; ms?: number } | undefined;
    const lastSuccessRaw = (statusDoc as any)?.lastSuccessByJob?.[
      "tekmetric-incremental-sync"
    ] as Date | string | undefined;
    if (lastRun?.dt) {
      const d = lastRun.dt instanceof Date ? lastRun.dt : new Date(lastRun.dt);
      if (!isNaN(d.getTime())) incrementalSync.lastRunAt = d.toISOString();
      incrementalSync.lastDurationMs =
        typeof lastRun.ms === "number" ? lastRun.ms : null;
    }
    if (lastSuccessRaw) {
      const d =
        lastSuccessRaw instanceof Date ? lastSuccessRaw : new Date(lastSuccessRaw);
      if (!isNaN(d.getTime())) incrementalSync.lastSuccessAt = d.toISOString();
    }
  } catch (err: any) {
    console.warn(
      "[webhook-subscription-status] cron_status lookup failed:",
      err?.message,
    );
  }

  // Whether we're actually managing subscriptions programmatically. When
  // auto-subscribe is OFF (the default), `subscribeShopToTekmetricWebhooks`
  // returns early WITHOUT persisting a row, so a `missing` subscriptionStatus
  // just means "we've never tried" — not an alarm. The UI / alerter use this
  // flag to decide whether a `missing` subscription is actionable (task #569).
  const autoSubscribeEnabled =
    process.env.TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE === "true";

  const summary = (tekShops as any[]).map(shop => {
    const tekId = Number(shop.tekmetric.shopId);
    const stats = byShop.get(tekId);
    const sub = subByShop.get(tekId);
    const totalLast24h = stats?.totalLast24h || 0;
    const totalLast7d = stats?.totalLast7d || 0;
    let healthStatus: "healthy" | "stale" | "silent" = "silent";
    if (totalLast24h > 0) healthStatus = "healthy";
    else if (totalLast7d > 0) healthStatus = "stale";

    // Subscription status (task #569): is this shop's webhook subscription
    // registered, errored, or never wired up?
    //   - `subscribed` — last auto-subscribe attempt succeeded
    //   - `error`      — last attempt ran but failed (HTTP / auth / network)
    //   - `missing`    — no subscription record at all (never auto-subscribed)
    let subscriptionStatus: "subscribed" | "error" | "missing" = "missing";
    if (sub?.lastResult) {
      subscriptionStatus = sub.lastResult.ok === true ? "subscribed" : "error";
    }

    // Task #1089 (webhook-first sync): show which poll cadence the
    // incremental sync applies to this shop right now, and why.
    const coverage = classifyWebhookCoverage({
      autoSubscribeEnabled,
      subscriptionOk: subscriptionStatus === "subscribed",
      lastWebhookEventAt: shop.tekmetric?.lastWebhookEventAt || null,
    });
    const cadence = selectPollCadence({
      coverage,
      lastSyncCursor: shop.tekmetric?.lastSyncCursor || null,
    });

    return {
      tekmetricShopId: tekId,
      mosShopId: shop.shopId,
      name: shop.name || "(unnamed)",
      healthStatus,
      subscriptionStatus,
      totalLast24h,
      totalLast7d,
      totalLast30d: stats?.totalLast30d || 0,
      lastEventAt: stats?.lastEventAt || null,
      lastWebhookEventAt: shop.tekmetric?.lastWebhookEventAt || null,
      webhookCovered: coverage.covered,
      coverageReason: coverage.reason,
      pollCadence: cadence.cadence,
      eventTypeBreakdown: stats?.eventTypeBreakdown || [],
      autoSubscribe: sub
        ? {
            lastAttemptAt: sub.lastAttemptAt || null,
            firstAttemptAt: sub.firstAttemptAt || null,
            lastResult: sub.lastResult || null,
            events: sub.events || [],
          }
        : null,
    };
  }).sort((a, b) => {
    const order = { silent: 0, stale: 1, healthy: 2 };
    return order[a.healthStatus] - order[b.healthStatus];
  });

  const counts = {
    healthy: summary.filter(s => s.healthStatus === "healthy").length,
    stale: summary.filter(s => s.healthStatus === "stale").length,
    silent: summary.filter(s => s.healthStatus === "silent").length,
    total: summary.length,
  };

  const subscriptionCounts = {
    subscribed: summary.filter(s => s.subscriptionStatus === "subscribed").length,
    error: summary.filter(s => s.subscriptionStatus === "error").length,
    missing: summary.filter(s => s.subscriptionStatus === "missing").length,
    total: summary.length,
  };

  const coverageCounts = {
    covered: summary.filter(s => s.webhookCovered).length,
    fastPoll: summary.filter(s => s.pollCadence === "fast").length,
    safetyNetPoll: summary.filter(s => s.pollCadence === "safety-net").length,
    total: summary.length,
  };

  return NextResponse.json({
    counts,
    subscriptionCounts,
    coverageCounts,
    webhookFirst: {
      disabled: isWebhookFirstDisabled(),
      safetyNetPollMs: getSafetyNetPollMs(),
    },
    autoSubscribeEnabled,
    summary,
    latency,
    incrementalSync,
    note: "Health: `healthy` = events in last 24h, `stale` = no events 24h but some in 7d, `silent` = no events in 7d. Subscription: `subscribed`/`error`/`missing`; `missing` is only actionable when autoSubscribeEnabled=true. Sorted silent → stale → healthy. See TEKMETRIC_5K_SCALING_PLAN.md Step 3.",
  });
}
