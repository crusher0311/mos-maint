import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail } from "@/lib/email";

/**
 * Test seam (mirrors the Tekmetric webhook-health route): the handler
 * dereferences `__deps.getDb` / `__deps.sendEmail` at call time so a smoke
 * test can swap in fakes. Production callers never touch this object.
 */
export const __deps = { getDb, sendEmail };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RECEIPT_DROP_RATIO = Number(process.env.SHOPMONKEY_WEBHOOK_RECEIPT_DROP_RATIO || 0.5);
const RECEIPT_DROP_MIN_7D = Number(process.env.SHOPMONKEY_WEBHOOK_RECEIPT_DROP_MIN_7D || 14);

/**
 * Shopmonkey webhook health monitor — mirror of
 * /api/cron/tekmetric-webhook-health (silent-shop + receipt-drop detection).
 *
 * For every Shopmonkey-connected shop it counts `shopmonkey_webhook_logs`
 * events over 24h/7d, flags shops that have gone silent or dropped below half
 * their trailing-week daily average, and emails platform admins a single
 * consolidated alert (idempotent per shop+UTC-day via
 * `shopmonkey_webhook_health_alerts`).
 *
 * PROD-SAFE: no-op (scanned:0) when zero shops are configured. The
 * missing-subscription check is gated behind
 * `SHOPMONKEY_WEBHOOK_AUTO_SUBSCRIBE` exactly like Tekmetric, so with
 * auto-subscribe OFF (default) it never mass-false-positives the fleet.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "";
  if (expected && auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await __deps.getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const today = new Date().toISOString().slice(0, 10);

  const smShops = await db.collection("shops").find(
    { "shopmonkey.apiKey": { $exists: true, $ne: null } },
    { projection: { shopId: 1, name: 1, "shopmonkey.locationId": 1 } },
  ).toArray();

  if (smShops.length === 0) {
    return NextResponse.json({ scanned: 0, silent: 0, alerted: 0, note: "no Shopmonkey shops" });
  }

  const shopIds = smShops.map((s: any) => Number(s.shopId)).filter(Boolean);

  await db.collection("shopmonkey_webhook_logs").createIndex(
    { receivedAt: -1 },
    { name: "receivedAt_-1" },
  ).catch(() => {});

  const agg = async (gte: Date) =>
    db.collection("shopmonkey_webhook_logs").aggregate([
      { $match: { receivedAt: { $gte: gte } } },
      { $project: { shopId: { $ifNull: ["$data.shopId", "$shopId"] } } },
      { $match: { shopId: { $in: shopIds } } },
      { $group: { _id: "$shopId", count: { $sum: 1 } } },
    ]).toArray();

  const counts24h = new Map<number, number>();
  for (const row of (await agg(since)) as Array<{ _id: number; count: number }>) {
    counts24h.set(Number(row._id), row.count);
  }
  const counts7d = new Map<number, number>();
  for (const row of (await agg(since7d)) as Array<{ _id: number; count: number }>) {
    counts7d.set(Number(row._id), row.count);
  }

  const silent: Array<{ mosShopId: any; name: string }> = [];
  const drops: Array<{ mosShopId: any; name: string; eventsLast24h: number; expectedDailyAverage: number }> = [];
  for (const shop of smShops as any[]) {
    const id = Number(shop.shopId);
    const c24 = counts24h.get(id) || 0;
    const c7 = counts7d.get(id) || 0;
    if (c24 === 0) {
      silent.push({ mosShopId: shop.shopId, name: shop.name || "(unnamed)" });
      continue;
    }
    if (c7 >= RECEIPT_DROP_MIN_7D) {
      const expected = c7 / 7;
      if (c24 < RECEIPT_DROP_RATIO * expected) {
        drops.push({
          mosShopId: shop.shopId,
          name: shop.name || "(unnamed)",
          eventsLast24h: c24,
          expectedDailyAverage: Math.round(expected * 10) / 10,
        });
      }
    }
  }

  const alertsCollection = db.collection("shopmonkey_webhook_health_alerts");
  await alertsCollection.createIndex(
    { mosShopId: 1, alertDate: 1, alertKind: 1 },
    { unique: true, name: "uniq_shop_date_kind" },
  ).catch(() => {});

  const newAlert = async (mosShopId: any, alertKind: string, extra: Record<string, any> = {}) => {
    try {
      await alertsCollection.insertOne({ mosShopId, alertDate: today, alertKind, createdAt: new Date(), ...extra });
      return true;
    } catch (err: any) {
      if (err?.code !== 11000) {
        console.error(`[ShopmonkeyWebhookHealth] alert dedup failed (${alertKind}) for ${mosShopId}:`, err?.message);
      }
      return false;
    }
  };

  const toAlertSilent = [];
  for (const s of silent) if (await newAlert(s.mosShopId, "silent")) toAlertSilent.push(s);
  const toAlertDrop = [];
  for (const d of drops) {
    if (await newAlert(d.mosShopId, "drop", { eventsLast24h: d.eventsLast24h, expectedDailyAverage: d.expectedDailyAverage })) {
      toAlertDrop.push(d);
    }
  }

  let emailed = 0;
  if (toAlertSilent.length > 0 || toAlertDrop.length > 0) {
    const admins = await db.collection("users").find(
      { isPlatformAdmin: true, email: { $exists: true, $ne: null } },
      { projection: { email: 1 } },
    ).toArray();
    if (admins.length > 0) {
      const lines: string[] = [];
      if (toAlertSilent.length > 0) {
        lines.push(`<h3>Silent shops (0 events in 24h) — ${toAlertSilent.length}</h3><ul>${toAlertSilent.map((s) => `<li>${s.name} (MOS ${s.mosShopId})</li>`).join("")}</ul>`);
      }
      if (toAlertDrop.length > 0) {
        lines.push(`<h3>Receipt-rate drop — ${toAlertDrop.length}</h3><ul>${toAlertDrop.map((d) => `<li>${d.name} (MOS ${d.mosShopId}): ${d.eventsLast24h} vs ~${d.expectedDailyAverage}/day</li>`).join("")}</ul>`);
      }
      const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5"><h2>Shopmonkey Webhook Health — Daily Check</h2>${lines.join("\n")}<p style="color:#666;font-size:13px">Sent by /api/cron/shopmonkey-webhook-health</p></div>`;
      const subject = `[MOS] Shopmonkey webhook health: ${toAlertSilent.length} silent, ${toAlertDrop.length} drop`;
      for (const admin of admins as Array<{ email: string }>) {
        try {
          await __deps.sendEmail({ to: admin.email, subject, html });
          emailed++;
        } catch (err: any) {
          console.error(`[ShopmonkeyWebhookHealth] email send failed for ${admin.email}:`, err?.message);
        }
      }
    } else {
      console.warn("[ShopmonkeyWebhookHealth] No platform admins configured; alerts logged only");
    }
  }

  console.log(
    `[ShopmonkeyWebhookHealth] Scanned ${smShops.length} shops, ${silent.length} silent (${toAlertSilent.length} new), ${drops.length} drop (${toAlertDrop.length} new), emailed ${emailed} admin(s)`,
  );

  return NextResponse.json({
    scanned: smShops.length,
    silent: silent.length,
    newSilentAlerts: toAlertSilent.length,
    receiptDrops: drops.length,
    newDropAlerts: toAlertDrop.length,
    emailed,
    silentShops: silent,
  });
}
