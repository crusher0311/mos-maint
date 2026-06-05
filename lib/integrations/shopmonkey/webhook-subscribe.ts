/**
 * Shopmonkey webhook auto-subscription helper — mirrors
 * lib/integrations/tekmetric/webhook-subscribe.ts.
 *
 * Goal: when a shop connects Shopmonkey, programmatically register our webhook
 * URL so we don't depend on someone manually configuring it in the Shopmonkey
 * portal.
 *
 * Status: SCAFFOLDED — gated default-OFF. Mirrors Tekmetric exactly:
 *   1. Default-disable via env: only runs when
 *      `SHOPMONKEY_WEBHOOK_AUTO_SUBSCRIBE=true`.
 *   2. Configurable endpoint template
 *      (`SHOPMONKEY_WEBHOOK_SUBSCRIBE_URL_TEMPLATE`) so the path can be adjusted
 *      without a deploy. Template tokens:
 *        {locationId} → the Shopmonkey location ID
 *        {companyId}  → the Shopmonkey company ID
 *   3. Log every attempt + record the outcome in
 *      `shopmonkey_webhook_subscriptions` for the visibility endpoint to read.
 *
 * To enable in production, set:
 *   - SHOPMONKEY_WEBHOOK_AUTO_SUBSCRIBE=true
 *   - SHOPMONKEY_WEBHOOK_SUBSCRIBE_URL_TEMPLATE=https://api.shopmonkey.cloud/v3/webhook  (verify with partner)
 *   - SHOPMONKEY_WEBHOOK_PUBLIC_URL=https://<your-domain>/api/webhooks/shopmonkey
 */

import { getCredentials } from "@/lib/integrations/shopmonkey/auth";
import { getDb } from "@/lib/mongo";

const DEFAULT_EVENTS = [
  "order.created",
  "order.updated",
  "order.statusChanged",
  "order.invoiced",
  "inspection.completed",
];

export type SubscribeResult =
  | { ok: true; status: number; subscriptionId?: string; raw?: any }
  | { ok: false; reason: string; status?: number; raw?: any };

export async function subscribeShopToShopmonkeyWebhooks(opts: {
  mosShopId: number;
  locationId?: string;
  companyId?: string;
  events?: string[];
}): Promise<SubscribeResult> {
  if (process.env.SHOPMONKEY_WEBHOOK_AUTO_SUBSCRIBE !== "true") {
    return { ok: false, reason: "auto_subscribe_disabled" };
  }

  const template = process.env.SHOPMONKEY_WEBHOOK_SUBSCRIBE_URL_TEMPLATE;
  const publicUrl = process.env.SHOPMONKEY_WEBHOOK_PUBLIC_URL;
  if (!template || !publicUrl) {
    return { ok: false, reason: "missing_env: SHOPMONKEY_WEBHOOK_SUBSCRIBE_URL_TEMPLATE and/or SHOPMONKEY_WEBHOOK_PUBLIC_URL" };
  }

  const events = opts.events && opts.events.length > 0 ? opts.events : DEFAULT_EVENTS;
  const url = template
    .replace("{locationId}", String(opts.locationId ?? ""))
    .replace("{companyId}", String(opts.companyId ?? ""));

  let apiKey: string;
  try {
    const creds = await getCredentials(opts.mosShopId);
    if (!creds?.apiKey) {
      return { ok: false, reason: "auth_failed: no Shopmonkey API key configured" };
    }
    apiKey = creds.apiKey;
  } catch (err: any) {
    return { ok: false, reason: `auth_failed: ${err?.message || "unknown"}` };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: publicUrl, events }),
    });
  } catch (err: any) {
    return { ok: false, reason: `network: ${err?.message || "unknown"}` };
  }

  let raw: any = null;
  try {
    raw = await response.json();
  } catch {
    raw = null;
  }

  const result: SubscribeResult = response.ok
    ? { ok: true, status: response.status, subscriptionId: raw?.id || raw?.subscriptionId, raw }
    : { ok: false, reason: `http_${response.status}`, status: response.status, raw };

  try {
    const db = await getDb();
    await db.collection("shopmonkey_webhook_subscriptions").updateOne(
      { mosShopId: opts.mosShopId },
      {
        $set: {
          mosShopId: opts.mosShopId,
          locationId: opts.locationId ?? null,
          companyId: opts.companyId ?? null,
          lastAttemptAt: new Date(),
          lastResult: result,
          events,
          publicUrl,
        },
        $setOnInsert: { firstAttemptAt: new Date() },
      },
      { upsert: true },
    );
  } catch (err: any) {
    console.warn(`[ShopmonkeyWebhookSubscribe] Failed to persist outcome for shop ${opts.mosShopId}:`, err?.message);
  }

  return result;
}
