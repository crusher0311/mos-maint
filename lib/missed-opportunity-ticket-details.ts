/**
 * Browser-safe ticket-detail helpers for the Missed Opportunities report.
 * Keep this module free of server-only and database imports so the report UI
 * can share exact decimal and grouping behavior with the evaluator.
 */

export type TicketJobDisplayGroup =
  | "approved_performed"
  | "deferred_declined"
  | "other";

/** Compact service-job detail included with each report row. */
export interface MissedOpportunityTicketJob {
  title: string;
  /** The normalized provider status recorded on the service job. */
  recordedStatus: string | null;
  displayGroup: TicketJobDisplayGroup;
  /** Canonical decimal dollars, or null when no usable amount was recorded. */
  totalPrice: string | null;
}

const APPROVED_PERFORMED_STATUSES = new Set([
  "approved",
  "authorized",
  "in_progress",
  "completed",
  "performed",
]);

const DEFERRED_DECLINED_STATUSES = new Set([
  "declined",
  "deferred",
]);

/**
 * Map normalized and provider-originated status labels into report sections.
 * Unrecognized states deliberately stay visible in the neutral fallback.
 */
export function classifyTicketJobStatus(status: unknown): TicketJobDisplayGroup {
  const normalized =
    typeof status === "string"
      ? status.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
  if (APPROVED_PERFORMED_STATUSES.has(normalized)) return "approved_performed";
  if (DEFERRED_DECLINED_STATUSES.has(normalized)) return "deferred_declined";
  return "other";
}

/**
 * Preserve a database decimal as an exact, JSON-safe two-decimal string.
 * Invalid or over-precise inputs remain unavailable rather than being
 * silently converted to $0.00 or rounded.
 */
export function normalizeTicketJobAmount(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return null;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const raw = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const negative = match[1] === "-";
  const whole = match[2].replace(/^0+(?=\d)/, "");
  const fraction = (match[3] || "").padEnd(2, "0");
  const isZero = /^0+$/.test(whole) && fraction === "00";
  return `${negative && !isZero ? "-" : ""}${whole}.${fraction}`;
}

/** Format a canonical decimal string as US currency without Number coercion. */
export function formatTicketJobAmount(value: string | null | undefined): string | null {
  const normalized = normalizeTicketJobAmount(value);
  if (normalized == null) return null;
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction] = unsigned.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${fraction}`;
}

export function sumTicketJobAmounts(
  jobs: ReadonlyArray<Pick<MissedOpportunityTicketJob, "totalPrice">>,
): { total: string; hasUnavailable: boolean } {
  let cents = 0n;
  let hasUnavailable = false;
  for (const job of jobs) {
    const amount = normalizeTicketJobAmount(job.totalPrice);
    if (amount == null) {
      hasUnavailable = true;
      continue;
    }
    const negative = amount.startsWith("-");
    const unsigned = negative ? amount.slice(1) : amount;
    const [whole, fraction] = unsigned.split(".");
    const value = BigInt(whole) * 100n + BigInt(fraction);
    cents += negative ? -value : value;
  }
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");
  return {
    total: `${negative ? "-" : ""}${whole}.${fraction}`,
    hasUnavailable,
  };
}