/**
 * Tekmetric webhook auto-subscription helper — Step 3c of
 * TEKMETRIC_5K_SCALING_PLAN.md.
 *
 * Goal: when a shop connects Tekmetric, programmatically register our webhook
 * URL with Tekmetric so we don't depend on someone manually configuring it in
 * the Tekmetric portal (root cause of the 6 silent shops Step 1 found).
 *
 * Status: SCAFFOLDED — gated default-OFF.
 *
 * The exact subscription endpoint shape is not in the public Tekmetric API
 * docs we have on file; the partner team owns it. To keep this safe we:
 *   1. Default-disable via env: only runs when
 *      `TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE=true`.
 *   2. Use a configurable endpoint template
 *      (`TEKMETRIC_WEBHOOK_SUBSCRIBE_URL_TEMPLATE`) so we can adjust without
 *      a deploy when partner-eng confirms the path. Template tokens:
 *        {shopId}  → the Tekmetric shop ID
 *   3. Log every attempt + record the outcome in
 *      `tekmetric_webhook_subscriptions` for the visibility endpoint to read.
 *
 * To enable in production, set:
 *   - TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE=true
 *   - TEKMETRIC_WEBHOOK_SUBSCRIBE_URL_TEMPLATE=https://shop.tekmetric.com/api/v1/shop/{shopId}/webhooks  (verify with partner)
 *   - TEKMETRIC_WEBHOOK_PUBLIC_URL=https://<your-domain>/api/webhooks/tekmetric
 */

import { getValidAccessToken } from "@/lib/integrations/tekmetric/auth";
import { getDb } from "@/lib/mongo";

const DEFAULT_EVENTS = [
  "RepairOrder.Created",
  "RepairOrder.Updated",
  "RepairOrder.StatusChanged",
  "Inspection.Complete",
];

export type SubscribeResult =
  | { ok: true; status: number; subscriptionId?: string; raw?: any }
  | { ok: false; reason: string; status?: number; raw?: any };

export async function subscribeShopToTekmetricWebhooks(opts: {
  tekmetricShopId: number;
  mosShopId?: any;
  events?: string[];
}): Promise<SubscribeResult> {
  if (process.env.TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE !== "true") {
    return { ok: false, reason: "auto_subscribe_disabled" };
  }

  const template = process.env.TEKMETRIC_WEBHOOK_SUBSCRIBE_URL_TEMPLATE;
  const publicUrl = process.env.TEKMETRIC_WEBHOOK_PUBLIC_URL;
  if (!template || !publicUrl) {
    return { ok: false, reason: "missing_env: TEKMETRIC_WEBHOOK_SUBSCRIBE_URL_TEMPLATE and/or TEKMETRIC_WEBHOOK_PUBLIC_URL" };
  }

  const events = opts.events && opts.events.length > 0 ? opts.events : DEFAULT_EVENTS;
  const url = template.replace("{shopId}", String(opts.tekmetricShopId));

  let token: string;
  try {
    token = await getValidAccessToken();
  } catch (err: any) {
    return { ok: false, reason: `auth_failed: ${err?.message || "unknown"}` };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
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

  // Persist outcome for the visibility endpoint.
  try {
    const db = await getDb();
    await db.collection("tekmetric_webhook_subscriptions").updateOne(
      { tekmetricShopId: opts.tekmetricShopId },
      {
        $set: {
          tekmetricShopId: opts.tekmetricShopId,
          mosShopId: opts.mosShopId ?? null,
          lastAttemptAt: new Date(),
          lastResult: result,
          events,
          publicUrl,
        },
        $setOnInsert: { firstAttemptAt: new Date() },
      },
      { upsert: true }
    );
  } catch (err: any) {
    console.warn(`[TekmetricWebhookSubscribe] Failed to persist outcome for shop ${opts.tekmetricShopId}:`, err?.message);
  }

  return result;
}
