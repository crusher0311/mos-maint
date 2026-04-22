import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook health monitor — Step 3a of TEKMETRIC_5K_SCALING_PLAN.md.
 *
 * For every Tekmetric-connected shop, count `tekmetric_webhook_logs` events in
 * the last 24h. Shops with zero events are flagged as silent and an email is
 * sent to all platform admins.
 *
 * Idempotent: at most one alert per (shopId, alertDate-UTC) via the
 * `tekmetric_webhook_health_alerts` collection. Re-running the cron the same
 * day is a no-op for already-alerted shops.
 *
 * Step 1 surfaced 6 silent shops we hadn't noticed; this catches them
 * automatically going forward.
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

  const db = await getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
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

  // Per-shop event counts in the window. Webhook payloads use two shapes for
  // shop identification: `data.shopId` (most events) and `data.repairOrder.shopId`
  // (RO events with nested payload). Both are real shop IDs. We deliberately do
  // NOT fall back to `repairOrderId` — it's a different ID space and would
  // misattribute events.
  const eventCounts = await db.collection("tekmetric_webhook_logs").aggregate([
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

  const countByTekShopId = new Map<number, number>();
  for (const row of eventCounts as Array<{ _id: number; count: number }>) {
    countByTekShopId.set(Number(row._id), row.count);
  }

  const silent: Array<{ tekmetricShopId: number; mosShopId: any; name: string; eventsLast24h: number }> = [];
  for (const shop of tekShops as any[]) {
    const tekId = Number(shop.tekmetric.shopId);
    const count = countByTekShopId.get(tekId) || 0;
    if (count === 0) {
      silent.push({
        tekmetricShopId: tekId,
        mosShopId: shop.shopId,
        name: shop.name || "(unnamed)",
        eventsLast24h: 0,
      });
    }
  }

  // Filter out shops we've already alerted today (idempotency).
  const alertsCollection = db.collection("tekmetric_webhook_health_alerts");
  await alertsCollection.createIndex(
    { tekmetricShopId: 1, alertDate: 1 },
    { unique: true, name: "uniq_shop_date" }
  ).catch(() => {});

  const toAlert: typeof silent = [];
  for (const s of silent) {
    try {
      await alertsCollection.insertOne({
        tekmetricShopId: s.tekmetricShopId,
        mosShopId: s.mosShopId,
        alertDate: today,
        createdAt: new Date(),
      });
      toAlert.push(s);
    } catch (err: any) {
      // Duplicate key = already alerted today, skip silently.
      if (err?.code !== 11000) {
        console.error(`[TekmetricWebhookHealth] Alert dedup failed for shop ${s.tekmetricShopId}:`, err?.message);
      }
    }
  }

  // Send a single consolidated email per cron run instead of one-per-shop.
  let emailed = 0;
  if (toAlert.length > 0) {
    // Canonical field is `isPlatformAdmin` (see lib/auth.ts) — not `platformAdmin`.
    const admins = await db.collection("users").find(
      { isPlatformAdmin: true, email: { $exists: true, $ne: null } },
      { projection: { email: 1 } }
    ).toArray();

    if (admins.length === 0) {
      console.warn("[TekmetricWebhookHealth] No platform admins configured; alerts logged only");
    } else {
      const rows = toAlert.map(s => `
        <tr>
          <td style="padding:6px 12px;border:1px solid #ddd">${s.name}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${s.tekmetricShopId}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${s.mosShopId}</td>
        </tr>`).join("");
      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
          <h2>Tekmetric Webhook Silence — Daily Health Check</h2>
          <p>The following ${toAlert.length} Tekmetric shop(s) delivered <strong>zero webhook events</strong> in the last 24 hours.</p>
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
          </table>
          <p style="margin-top:16px;color:#666;font-size:13px">
            Sent by <code>/api/cron/tekmetric-webhook-health</code> · Diagnostic surface:
            <code>/api/platform-admin/tekmetric/webhook-subscription-status</code>
          </p>
        </div>`;
      for (const admin of admins as Array<{ email: string }>) {
        try {
          await sendEmail({
            to: admin.email,
            subject: `[MOS] Tekmetric webhook silence: ${toAlert.length} shop(s) flagged`,
            html,
          });
          emailed++;
        } catch (err: any) {
          console.error(`[TekmetricWebhookHealth] Email send failed for ${admin.email}:`, err?.message);
        }
      }
    }
  }

  console.log(`[TekmetricWebhookHealth] Scanned ${tekShops.length} shops, ${silent.length} silent (${toAlert.length} new alerts), emailed ${emailed} admin(s)`);

  return NextResponse.json({
    scanned: tekShops.length,
    silent: silent.length,
    newAlerts: toAlert.length,
    alreadyAlertedToday: silent.length - toAlert.length,
    emailed,
    silentShops: silent,
  });
}
