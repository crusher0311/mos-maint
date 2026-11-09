import { validateFleetHistoryConfig } from "@/lib/integrations/protractor/fleet-history-policy";
import type { ShopHistorySchedule } from "@/lib/integrations/protractor/history-schedule";
export type HistoryConfig = {
  revision: string;
  enabled: boolean;
  maxShopsPerTick: number;
  horizonYears: number;
  defaultTimezone: string | null;
  week: Array<{ day: number; open: string; close: string; closed: boolean }>;
  rolloutShopIds: number[];
  shopSchedules?: ShopHistorySchedule[];
};

export type HistoryShop = {
  shopId: number;
  name: string;
  status: string;
  reason: string;
  paused: boolean;
  completed: boolean;
  lastError: string | null;
  schedule?: { timezone: string | null; source: string; issue: string | null;
    hoursSource: string; week: HistoryConfig["week"] };
  nextEligibleAt?: string | null;
  progress?: { oldestCursorAt: string | null; lastAttemptAt: string | null };
};

export type HistorySnapshot = {
  config: HistoryConfig;
  runtime: { active: boolean; shopId: number | null; lastOutcome: string | null;
    worker?: { status: string; ready: boolean; lastSeenAt: string | null; revision: string | null } };
  shops: HistoryShop[];
};

export type ShopAction = "pause" | "resume" | "retry" | "queue";
export const ENDPOINT = "/api/platform-admin/protractor-history";

export class HistoryRequestError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "HistoryRequestError";
  }
}

// All writes are explicit; importing this module or loading status never starts work.
export async function historyRequest(
  method: "GET" | "PUT" | "POST",
  body?: unknown,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(ENDPOINT, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new HistoryRequestError(
      typeof payload?.error === "string" ? payload.error : `Request failed (HTTP ${response.status}).`,
      response.status,
    );
  }
  if (method === "GET" && (!payload?.config || !payload?.runtime || !Array.isArray(payload?.shops))) {
    throw new Error("History status is unavailable: the server returned an incomplete response.");
  }
  return payload;
}

export function validateConfig(config: HistoryConfig): string | null {
  if (!Number.isInteger(config.maxShopsPerTick) || config.maxShopsPerTick < 1 || config.maxShopsPerTick > 3)
    return "Choose between 1 and 3 shops per tick.";
  if (!Number.isInteger(config.horizonYears) || config.horizonYears < 1 || config.horizonYears > 5)
    return "Choose a history horizon between 1 and 5 years.";
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (config.week.length !== 7 || new Set(config.week.map(row => row.day)).size !== 7 ||
    config.week.some(row => !Number.isInteger(row.day) || row.day < 0 || row.day > 6 ||
      (!row.closed && (!time.test(row.open) || !time.test(row.close) || row.open === row.close)))) {
    return "Provide all seven days with valid, distinct opening and closing times, or mark the day closed.";
  }
  if (config.rolloutShopIds.some(id => !Number.isSafeInteger(id) || id <= 0))
    return "The rollout contains an invalid shop selection. Reload configuration.";
  if (config.defaultTimezone) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: config.defaultTimezone }); }
    catch { return "Enter a valid IANA timezone, such as America/Chicago, or leave the fallback blank."; }
  }
  try {
    validateFleetHistoryConfig({ ...config, week: config.week.map(row => row.closed
      ? { ...row, open: row.open || "00:00", close: row.close || "00:00" } : row) });
  } catch { return "Check each shop override: seven valid days, a valid timezone, and no duplicate shops are required."; }
  return null;
}

export function needsExpansionConfirmation(saved: HistoryConfig, next: HistoryConfig): boolean {
  if (!next.enabled) return false;
  if (!saved.enabled) return true;
  if (next.horizonYears > saved.horizonYears) return true;
  if (!saved.rolloutShopIds.length) return false;
  return !next.rolloutShopIds.length ||
    next.rolloutShopIds.some(id => !saved.rolloutShopIds.includes(id));
}

// Never surface arbitrary server diagnostic strings (which may contain identifiers).
const labels: Record<string, string> = {
  missing_hours: "Missing business hours",
  missing_timezone: "Missing timezone",
  missing_hours_or_timezone: "Missing business hours or timezone",
  "missing_hours/timezone": "Missing business hours or timezone",
  rollout: "Outside rollout",
  outside_rollout: "Outside rollout",
  disabled: "Sync disabled",
  paused: "Paused",
  emergency_stop: "Emergency stop active",
  transport_unavailable: "Provider transport unavailable",
  connection_review_required: "Connection needs review",
  cancelled: "Shop cancelled",
  waiting_off_hours: "Waiting for off-hours",
  waiting_offhours: "Waiting for off-hours",
  waiting_for_off_hours: "Waiting for off-hours",
  queued: "Queued",
  complete: "Complete",
  completed: "Complete",
  running: "Running",
  retry_backoff: "Retry backoff",
  idle: "Idle",
  eligible: "Eligible",
  error: "Needs attention",
  failed: "Needs attention",
  blocked: "Blocked",
  worker_unavailable: "Dedicated worker is not ready",
  not_reported: "No worker heartbeat — provisioning unverified",
  stale: "Worker heartbeat stale",
  stopped: "Worker stopped",
  readiness_only: "Readiness-only worker — imports disabled",
  upgrade_required: "Worker upgrade required",
  invalid_timezone: "Invalid saved timezone",
  ambiguous_location: "Provider location needs review",
  unsupported_provider_timezone: "Provider timezone needs mapping",
};
export function scheduleSource(value?: string): string {
  return ({ protractor: "Protractor location", shop_setting: "Saved shop setting",
    history_override: "History scheduling override", confirmed_fallback: "Confirmed fallback",
    unknown: "Not available", shared_policy: "Shared business-hours policy", shop_override: "Shop-specific business hours",
  } as Record<string, string>)[value || ""] || "Not available";
}
export function shopTime(value: string | null | undefined, timezone?: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (!Number.isFinite(+date)) return "Not available";
  try { return new Intl.DateTimeFormat("en-US", { timeZone: timezone || "UTC",
    dateStyle: "medium", timeStyle: "short" }).format(date) + ` (${timezone || "UTC"})`; }
  catch { return "Not available"; }
}
export function statusLabel(value: string | null): string {
  return labels[(value || "").toLowerCase().replace(/[\s-]+/g, "_")] || "Not reported";
}
