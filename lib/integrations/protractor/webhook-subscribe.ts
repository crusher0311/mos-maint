/**
 * Protractor webhook subscription helper — task #569 (Keep data fresh via
 * webhooks at scale).
 *
 * Unlike Tekmetric, Protractor exposes NO programmatic webhook-subscription
 * API: registering a callback URL is a manual step a shop (or our support
 * team) performs inside the Protractor portal. What we CAN own end-to-end is
 * our side of the contract:
 *
 *   1. The per-shop `protractorWebhookToken` on the shops doc — every shop
 *      that connects Protractor needs one, and it must never be missing
 *      (a missing token means the callback URL can't be built, so the shop
 *      is un-subscribable). Generating a missing token is a real repair.
 *   2. The callback URL the portal must point at:
 *        `${publicBase}/api/webhooks/protractor/{token}`
 *   3. A `protractor_webhook_subscriptions` bookkeeping row so the
 *      webhook-health / sweep surfaces can tell "we have a token + URL ready"
 *      apart from "this shop was never wired up".
 *
 * This helper guarantees (1)–(3). It deliberately does NOT fabricate a
 * Protractor-side subscription (there's no API to call) — `registrationMode`
 * is recorded as `"manual"` so the freshness runbook and health view make the
 * manual portal step explicit.
 */

import { getDb } from "@/lib/mongo";
import { ensureSubscriptionRecord } from "@/lib/data/repositories/protractor-webhook-subscriptions";
import crypto from "crypto";
import type { Db } from "mongodb";

export type EnsureProtractorSubscriptionResult = {
  ok: boolean;
  shopId: number;
  token: string | null;
  callbackUrl: string | null;
  /** true when this call generated a previously-missing token (a repair). */
  generatedToken: boolean;
  registrationMode: "manual";
  reason?: string;
};

/**
 * Resolve the public base URL the Protractor portal should call back into.
 * Mirrors the precedence used by the onboarding fire-and-forget triggers
 * (`REPLIT_DEV_DOMAIN` → `NEXT_PUBLIC_APP_URL`), with a dedicated override
 * (`PROTRACTOR_WEBHOOK_PUBLIC_BASE_URL`) so the callback host can be pinned
 * to the production domain without a redeploy.
 */
export function resolveProtractorWebhookBaseUrl(): string | null {
  const explicit = process.env.PROTRACTOR_WEBHOOK_PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  }
  return null;
}

export function buildProtractorCallbackUrl(token: string): string | null {
  const base = resolveProtractorWebhookBaseUrl();
  if (!base) return null;
  return `${base}/api/webhooks/protractor/${token}`;
}

/**
 * Guarantee a Protractor shop's side of the webhook contract: a non-empty
 * `protractorWebhookToken`, a recorded callback URL, and a bookkeeping row in
 * `protractor_webhook_subscriptions`. Idempotent and safe to call on every
 * onboarding and on every sweep tick.
 *
 * Pass an existing `db` handle to reuse a connection (the sweep cron does this
 * for its whole batch); otherwise one is opened lazily.
 */
export async function ensureProtractorWebhookSubscription(opts: {
  shopId: number;
  db?: Db;
}): Promise<EnsureProtractorSubscriptionResult> {
  const shopId = Number(opts.shopId);
  if (!Number.isFinite(shopId)) {
    return {
      ok: false,
      shopId,
      token: null,
      callbackUrl: null,
      generatedToken: false,
      registrationMode: "manual",
      reason: "invalid_shop_id",
    };
  }

  const db = opts.db ?? (await getDb());

  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { protractorWebhookToken: 1 } },
  );

  let token: string | undefined = shop?.protractorWebhookToken;
  let generatedToken = false;
  if (!token) {
    token = crypto.randomBytes(16).toString("hex");
    generatedToken = true;
    await db.collection("shops").updateOne(
      { shopId },
      { $set: { protractorWebhookToken: token } },
    );
  }

  const callbackUrl = buildProtractorCallbackUrl(token);

  try {
    const now = new Date();
    await ensureSubscriptionRecord(shopId, {
      token: token ?? null,
      callbackUrl,
      registrationMode: "manual",
      lastEnsuredAt: now,
      firstEnsuredAt: now,
    });
  } catch (err: any) {
    console.warn(
      `[ProtractorWebhookSubscribe] Failed to persist subscription record for shop ${shopId}:`,
      err?.message,
    );
  }

  return {
    ok: true,
    shopId,
    token: token ?? null,
    callbackUrl,
    generatedToken,
    registrationMode: "manual",
  };
}
