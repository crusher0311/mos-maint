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

import { getValidToken } from "@/lib/integrations/tekmetric/auth";
import { upsertWebhookSubscription } from "@/lib/data/repositories/tekmetric-ops";

const DEFAULT_EVENTS = [
  "RepairOrder.Created",
  "RepairOrder.Updated",
  "RepairOrder.StatusChanged",
  "Inspection.Complete",
];

export type SubscribeResult =
  | { ok: true; status: number; subscriptionId?: string; raw?: any; attempts?: number }
  | { ok: false; reason: string; status?: number; raw?: any; attempts?: number };

/**
 * Injectable seams for tests (retry behavior is exercised without touching
 * the network or the token endpoint). Production callers never pass this.
 */
export interface SubscribeDeps {
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  persist?: typeof upsertWebhookSubscription;
}

// Task #1089: bounded retry with backoff for TRANSIENT failures (network
// errors, 5xx, 429). Permanent failures (other 4xx — bad template, auth
// rejection) fail fast; the daily subscription sweep re-attempts them anyway.
const MAX_ATTEMPTS = Math.max(1, Number(process.env.TEKMETRIC_WEBHOOK_SUBSCRIBE_MAX_ATTEMPTS) || 3);
const RETRY_BASE_MS = 500;

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function subscribeShopToTekmetricWebhooks(opts: {
  tekmetricShopId: number;
  mosShopId?: any;
  events?: string[];
}, deps: SubscribeDeps = {}): Promise<SubscribeResult> {
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
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  let token: string;
  try {
    token = await (deps.getToken ? deps.getToken() : getValidToken());
  } catch (err: any) {
    return { ok: false, reason: `auth_failed: ${err?.message || "unknown"}` };
  }

  let result: SubscribeResult = { ok: false, reason: "not_attempted" };
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    let response: Response | null = null;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: publicUrl, events }),
      });
    } catch (err: any) {
      result = { ok: false, reason: `network: ${err?.message || "unknown"}` };
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
      continue; // network errors are transient — retry
    }

    let raw: any = null;
    try {
      raw = await response.json();
    } catch {
      raw = null;
    }

    if (response.ok) {
      result = { ok: true, status: response.status, subscriptionId: raw?.id || raw?.subscriptionId, raw };
      break;
    }

    result = { ok: false, reason: `http_${response.status}`, status: response.status, raw };
    if (!isTransientStatus(response.status)) break; // permanent — fail fast
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
  }
  result.attempts = attempts;

  // Persist outcome for the visibility endpoint.
  try {
    await (deps.persist ?? upsertWebhookSubscription)(
      opts.tekmetricShopId,
      {
        tekmetricShopId: opts.tekmetricShopId,
        mosShopId: opts.mosShopId ?? null,
        lastAttemptAt: new Date(),
        lastResult: result,
        events,
        publicUrl,
      },
      { firstAttemptAt: new Date() },
    );
  } catch (err: any) {
    console.warn(`[TekmetricWebhookSubscribe] Failed to persist outcome for shop ${opts.tekmetricShopId}:`, err?.message);
  }

  return result;
}
