/**
 * Task #484: Live VHI push to the Detect Dog extension overlay via
 * Supabase Realtime "broadcast" channels.
 *
 * Server-side broadcaster. Fire-and-forget. Never throws — failures are
 * logged and the caller proceeds (extension falls back to its existing
 * polling cadence).
 *
 * Channel layout: `vhi:{shopId}:{vin}`
 *   - Scoped to a single shop so the realtime RLS policy on
 *     `realtime.messages` can constrain a client JWT to its own shop
 *     (see app/api/extension/realtime-token/route.ts).
 *
 * Payload: `{ vin, shopId, updatedAt, reason }`
 *   - `reason` is a short tag the extension may surface (e.g.
 *     "plan_cache_invalidated", "tekmetric_webhook", "backfill_per_ro").
 *
 * Transport: Supabase Broadcast REST endpoint at
 *   POST {SUPABASE_URL}/realtime/v1/api/broadcast
 * with the service role key. Avoids adding `@supabase/supabase-js`
 * to the server bundle since we only need to publish, not subscribe.
 *
 * Env flag: VHI_REALTIME_PUSH_ENABLED=true must be set, otherwise this
 * is a no-op (extension keeps polling). Missing SUPABASE_URL or
 * SUPABASE_SERVICE_ROLE_KEY also short-circuits to no-op with a single
 * warn log so partial config never breaks the inline call sites.
 */

/**
 * Reason taxonomy is the observability contract for this push. Keep these
 * three values stable — Better Stack dashboards and the extension's status
 * logging key off them.
 */
export type VhiBroadcastReason =
  | "plan_cache_invalidate"
  | "tekmetric_webhook"
  | "fullpage_backfill";

export interface VhiBroadcastInput {
  vin: string;
  shopId: number | string;
  reason: VhiBroadcastReason;
  /** Override clock — tests only. */
  now?: () => number;
  /** Override transport — tests only. */
  fetchImpl?: typeof fetch;
}

interface DebounceEntry {
  lastSentAt: number;
}

/** In-process debounce: at most one broadcast per (shopId, vin) every N ms. */
const DEBOUNCE_MS = 750;
const debounceMap = new Map<string, DebounceEntry>();

let configWarned = false;

export function isVhiRealtimeEnabled(): boolean {
  return process.env.VHI_REALTIME_PUSH_ENABLED === "true";
}

function broadcastConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    if (!configWarned) {
      console.warn(
        "[VHI Realtime] VHI_REALTIME_PUSH_ENABLED=true but SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing — broadcasts disabled (extension will keep polling)"
      );
      configWarned = true;
    }
    return null;
  }
  return { url: url.replace(/\/$/, ""), key };
}

export function _resetVhiBroadcastStateForTests(): void {
  debounceMap.clear();
  configWarned = false;
}

/**
 * Fire-and-forget broadcast. Returns a promise resolving to:
 *   "sent"        — POST accepted (HTTP 2xx)
 *   "debounced"   — suppressed by the (shopId,vin) per-process debounce
 *   "disabled"    — env flag off or config missing
 *   "failed"      — transport or non-2xx response (logged, never thrown)
 *
 * The promise is fulfilled even on failure so callers can `.catch(() => {})`
 * defensively without any unhandled-rejection risk.
 */
export async function broadcastVhiUpdated(
  input: VhiBroadcastInput
): Promise<"sent" | "debounced" | "disabled" | "failed"> {
  if (!isVhiRealtimeEnabled()) return "disabled";

  const vin = (input.vin || "").toUpperCase();
  const shopId = String(input.shopId ?? "");
  if (!vin || !shopId) return "disabled";

  const now = (input.now || Date.now)();
  const key = `${shopId}:${vin}`;
  const prev = debounceMap.get(key);
  if (prev && now - prev.lastSentAt < DEBOUNCE_MS) {
    return "debounced";
  }
  debounceMap.set(key, { lastSentAt: now });

  const cfg = broadcastConfig();
  if (!cfg) return "disabled";

  const topic = `vhi:${shopId}:${vin}`;
  const payload = {
    vin,
    shopId: Number.isFinite(Number(shopId)) ? Number(shopId) : shopId,
    updatedAt: new Date(now).toISOString(),
    reason: input.reason,
  };

  const body = JSON.stringify({
    messages: [
      {
        topic,
        event: "vhi.updated",
        payload,
        private: true,
      },
    ],
  });

  try {
    const f = input.fetchImpl || fetch;
    const res = await f(`${cfg.url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[VHI Realtime] Broadcast ${topic} got ${res.status}: ${text.substring(0, 200)}`
      );
      return "failed";
    }
    return "sent";
  } catch (err: any) {
    console.warn(`[VHI Realtime] Broadcast ${topic} failed: ${err?.message || err}`);
    return "failed";
  }
}
