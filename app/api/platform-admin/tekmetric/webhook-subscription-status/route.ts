import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

async function isPlatformAdmin(): Promise<boolean> {
  const store = await cookies();
  const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
  if (!sid) return false;

  const db = await getDb();
  const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: new Date() } });
  if (!sess) return false;

  const user = await db.collection("users").findOne({ _id: sess.userId });
  return user?.platformAdmin === true;
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
    { projection: { shopId: 1, name: 1, "tekmetric.shopId": 1 } }
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

  // 3c: surface latest auto-subscribe outcome alongside event health so a human
  // can see "subscription registered OK on date X but events stopped on date Y".
  const subRows = await db.collection("tekmetric_webhook_subscriptions").find(
    { tekmetricShopId: { $in: tekShopIds } },
    { projection: { tekmetricShopId: 1, lastResult: 1, lastAttemptAt: 1, firstAttemptAt: 1, events: 1 } }
  ).toArray();
  const subByShop = new Map<number, any>();
  for (const s of subRows as any[]) subByShop.set(Number(s.tekmetricShopId), s);

  const summary = (tekShops as any[]).map(shop => {
    const tekId = Number(shop.tekmetric.shopId);
    const stats = byShop.get(tekId);
    const sub = subByShop.get(tekId);
    const totalLast24h = stats?.totalLast24h || 0;
    const totalLast7d = stats?.totalLast7d || 0;
    let healthStatus: "healthy" | "stale" | "silent" = "silent";
    if (totalLast24h > 0) healthStatus = "healthy";
    else if (totalLast7d > 0) healthStatus = "stale";
    return {
      tekmetricShopId: tekId,
      mosShopId: shop.shopId,
      name: shop.name || "(unnamed)",
      healthStatus,
      totalLast24h,
      totalLast7d,
      totalLast30d: stats?.totalLast30d || 0,
      lastEventAt: stats?.lastEventAt || null,
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

  return NextResponse.json({
    counts,
    summary,
    note: "Health: `healthy` = events in last 24h, `stale` = no events 24h but some in 7d, `silent` = no events in 7d. Sorted silent → stale → healthy. See TEKMETRIC_5K_SCALING_PLAN.md Step 3.",
  });
}
