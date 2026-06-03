import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { subscribeShopToTekmetricWebhooks } from "@/lib/integrations/tekmetric/webhook-subscribe";
import { ensureProtractorWebhookSubscription } from "@/lib/integrations/protractor/webhook-subscribe";

/**
 * Test seam — same pattern as the webhook-health crons. The route
 * dereferences `__deps.*` at call time so the route-level smoke test can
 * swap in fakes without touching Mongo or the real provider helpers.
 * Production callers should never touch this object.
 */
export const __deps = {
  getDb,
  subscribeShopToTekmetricWebhooks,
  ensureProtractorWebhookSubscription,
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook subscription sweep — task #569, step 2 ("backfill existing shops").
 *
 * Onboarding (step 1) now auto-subscribes each NEW shop to its provider
 * webhooks. This cron closes the loop for shops that connected before that
 * wiring existed (and re-verifies everyone on a slow cadence) so freshness
 * never silently depends on a manual step that was skipped months ago.
 *
 * Per provider:
 *   - Tekmetric: calls `subscribeShopToTekmetricWebhooks` for every
 *     Tekmetric-connected shop. The helper is gated default-OFF behind
 *     `TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE`; when disabled it's a no-op that
 *     returns `auto_subscribe_disabled` (counted as `skipped`), so this
 *     sweep is safe to run in production today and starts repairing
 *     subscriptions automatically the moment auto-subscribe is flipped on.
 *   - Protractor: calls `ensureProtractorWebhookSubscription`, which
 *     guarantees the per-shop `protractorWebhookToken` exists (generating a
 *     missing one is a real repair — a shop with no token is un-subscribable)
 *     and records a `protractor_webhook_subscriptions` bookkeeping row.
 *     Protractor has no programmatic subscribe API, so the portal
 *     registration itself stays a documented manual step.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}` mirrors the other
 * cron routes. Kill switch: `WEBHOOK_SUBSCRIPTION_SWEEP_DISABLED=true`.
 *
 * Idempotent: re-running is safe — every operation is an upsert / "ensure".
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = process.env.CRON_SECRET
    ? `Bearer ${process.env.CRON_SECRET}`
    : "";
  if (expected && auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.WEBHOOK_SUBSCRIPTION_SWEEP_DISABLED === "true") {
    return NextResponse.json({ ok: true, disabled: true });
  }

  const db = await __deps.getDb();

  // ---------- Tekmetric ----------
  const tekShops = await db.collection("shops").find(
    { "tekmetric.shopId": { $exists: true } },
    { projection: { shopId: 1, "tekmetric.shopId": 1 } },
  ).toArray();

  const tekmetric = {
    scanned: 0,
    subscribed: 0,
    skipped: 0, // auto-subscribe disabled / safe no-op
    failed: 0,
    failures: [] as Array<{ tekmetricShopId: number; reason: string }>,
  };

  for (const shop of tekShops as any[]) {
    const tekId = Number(shop?.tekmetric?.shopId);
    if (!Number.isFinite(tekId)) continue;
    tekmetric.scanned++;
    try {
      const result = await __deps.subscribeShopToTekmetricWebhooks({
        tekmetricShopId: tekId,
        mosShopId: shop.shopId,
      });
      if (result.ok) {
        tekmetric.subscribed++;
      } else if (result.reason === "auto_subscribe_disabled") {
        tekmetric.skipped++;
      } else {
        tekmetric.failed++;
        if (tekmetric.failures.length < 25) {
          tekmetric.failures.push({ tekmetricShopId: tekId, reason: result.reason });
        }
      }
    } catch (err: any) {
      tekmetric.failed++;
      if (tekmetric.failures.length < 25) {
        tekmetric.failures.push({
          tekmetricShopId: tekId,
          reason: err?.message || "threw",
        });
      }
    }
  }

  // ---------- Protractor ----------
  const protractorShops = await db.collection("shops").find(
    { "protractor.configured": true },
    { projection: { shopId: 1 } },
  ).toArray();

  const protractor = {
    scanned: 0,
    ensured: 0,
    tokensGenerated: 0, // shops that were missing a token (real repair)
    failed: 0,
    failures: [] as Array<{ shopId: number; reason: string }>,
  };

  for (const shop of protractorShops as any[]) {
    const sid = Number(shop?.shopId);
    if (!Number.isFinite(sid)) continue;
    protractor.scanned++;
    try {
      const result = await __deps.ensureProtractorWebhookSubscription({
        shopId: sid,
        db,
      });
      if (result.ok) {
        protractor.ensured++;
        if (result.generatedToken) protractor.tokensGenerated++;
      } else {
        protractor.failed++;
        if (protractor.failures.length < 25) {
          protractor.failures.push({ shopId: sid, reason: result.reason || "not_ok" });
        }
      }
    } catch (err: any) {
      protractor.failed++;
      if (protractor.failures.length < 25) {
        protractor.failures.push({ shopId: sid, reason: err?.message || "threw" });
      }
    }
  }

  console.log(
    `[WebhookSubscriptionSweep] Tekmetric: scanned ${tekmetric.scanned}, subscribed ${tekmetric.subscribed}, skipped ${tekmetric.skipped}, failed ${tekmetric.failed}. ` +
      `Protractor: scanned ${protractor.scanned}, ensured ${protractor.ensured}, tokensGenerated ${protractor.tokensGenerated}, failed ${protractor.failed}.`,
  );

  return NextResponse.json({ ok: true, tekmetric, protractor });
}
