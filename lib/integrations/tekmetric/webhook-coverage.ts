/**
 * Webhook-first Tekmetric sync — coverage classification + poll cadence
 * selection (task #1089).
 *
 * Background polling every 2 minutes consumes most of the shared API key's
 * 10 RPS budget and competes with advisor-facing traffic. Shops with
 * confirmed, live webhook coverage don't need the fast poll: the webhook
 * receiver keeps their cache fresh in seconds. Those shops drop to a slow
 * safety-net poll; everyone else keeps the 2-minute cadence so nothing goes
 * stale.
 *
 * "Covered" is deliberately conservative — ALL of the following must hold:
 *   1. Auto-subscribe is enabled (TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE=true).
 *      With it off we manage no subscriptions, so nothing re-creates a
 *      deleted one — never trust coverage in that mode.
 *   2. The shop's managed subscription's last attempt succeeded
 *      (tekmetric_webhook_subscriptions.lastResult.ok === true).
 *   3. The shop has actually delivered a webhook event recently
 *      (shops.tekmetric.lastWebhookEventAt within the liveness window).
 *      A subscription that exists on paper but delivers nothing is treated
 *      as uncovered — the fast poll stays on.
 *
 * Kill switch: TEKMETRIC_WEBHOOK_FIRST_DISABLED=true forces every shop back
 * to the fast poll without touching subscriptions.
 *
 * Gap coverage note (task #1089 step 4): the webhook receiver handles RO
 * creates/updates/status changes (incl. terminal statuses, with inline job
 * indexing) and Inspection.Complete. It does NOT receive standalone
 * vehicle/customer update events — those are compensated by (a) the
 * enrichment fetches the webhook handler performs per RO and (b) the
 * safety-net poll below, which runs the full incremental sync (including
 * the terminal-status sweep) on every elapsed interval.
 */

// Safety-net poll interval for webhook-covered shops. Plan calls for
// 15–30 min; default 20. Env-tunable without a deploy.
export function getSafetyNetPollMs(): number {
  const v = Number(process.env.TEKMETRIC_WEBHOOK_SAFETY_NET_POLL_MS);
  return Number.isFinite(v) && v > 0 ? v : 20 * 60 * 1000;
}

// How recently a webhook event must have been received for the shop's
// coverage to count as "live". 24h default: quieter shops legitimately go
// hours without events overnight; a full day of silence means we should
// not trust the pipe (the daily webhook-health cron flags it too).
export function getWebhookLivenessMs(): number {
  const v = Number(process.env.TEKMETRIC_WEBHOOK_LIVENESS_MS);
  return Number.isFinite(v) && v > 0 ? v : 24 * 60 * 60 * 1000;
}

export function isWebhookFirstDisabled(): boolean {
  return process.env.TEKMETRIC_WEBHOOK_FIRST_DISABLED === "true";
}

export interface CoverageInput {
  autoSubscribeEnabled: boolean;
  subscriptionOk: boolean;
  lastWebhookEventAt: Date | string | null | undefined;
  now?: number;
  livenessMs?: number;
}

export interface CoverageResult {
  covered: boolean;
  reason:
    | "covered"
    | "auto_subscribe_off"
    | "no_healthy_subscription"
    | "webhook_stale"
    | "no_events_yet";
}

export function classifyWebhookCoverage(input: CoverageInput): CoverageResult {
  if (!input.autoSubscribeEnabled) return { covered: false, reason: "auto_subscribe_off" };
  if (!input.subscriptionOk) return { covered: false, reason: "no_healthy_subscription" };

  const last = input.lastWebhookEventAt ? new Date(input.lastWebhookEventAt) : null;
  if (!last || isNaN(last.getTime())) return { covered: false, reason: "no_events_yet" };

  const now = input.now ?? Date.now();
  const livenessMs = input.livenessMs ?? getWebhookLivenessMs();
  if (now - last.getTime() > livenessMs) return { covered: false, reason: "webhook_stale" };

  return { covered: true, reason: "covered" };
}

export interface CadenceInput {
  coverage: CoverageResult;
  lastSyncCursor: Date | string | null | undefined;
  now?: number;
  safetyNetMs?: number;
  webhookFirstDisabled?: boolean;
}

export interface CadenceResult {
  poll: boolean;
  cadence: "fast" | "safety-net";
  /** Set when poll=false: why this tick is being skipped. */
  skipReason?: string;
}

/**
 * Decide whether a shop should be polled this tick.
 *
 * - Uncovered shops (or webhook-first disabled): always poll (fast cadence).
 * - Covered shops: poll only when the safety-net interval has elapsed since
 *   the last successful sync cursor. A covered shop with no cursor at all is
 *   polled immediately (never let a brand-new shop wait out the interval).
 */
export function selectPollCadence(input: CadenceInput): CadenceResult {
  const disabled = input.webhookFirstDisabled ?? isWebhookFirstDisabled();
  if (disabled || !input.coverage.covered) {
    return { poll: true, cadence: "fast" };
  }

  const cursor = input.lastSyncCursor ? new Date(input.lastSyncCursor) : null;
  if (!cursor || isNaN(cursor.getTime())) {
    return { poll: true, cadence: "safety-net" };
  }

  const now = input.now ?? Date.now();
  const safetyNetMs = input.safetyNetMs ?? getSafetyNetPollMs();
  const elapsed = now - cursor.getTime();
  if (elapsed >= safetyNetMs) {
    return { poll: true, cadence: "safety-net" };
  }

  const remainingS = Math.round((safetyNetMs - elapsed) / 1000);
  return {
    poll: false,
    cadence: "safety-net",
    skipReason: `webhook_covered (safety-net poll in ~${remainingS}s)`,
  };
}
