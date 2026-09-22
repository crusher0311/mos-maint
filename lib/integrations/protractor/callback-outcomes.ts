/**
 * The small, deliberately allowlisted record persisted for a callback
 * generation.  This is not a copy of provider data: it is bounded evidence
 * about what the drain did with the callback.
 */
export type CallbackHistoryOutcomeCategory =
  | "applied_indexed"
  | "terminal_no_history"
  | "coalesced"
  | "deferred"
  | "failed";

export type CallbackHistoryOutcomeReason =
  | "indexed"
  | "no_jobs"
  | "open_work_order"
  | "missing_vin"
  | "vehicle_snapshot"
  | "terminal_applied"
  | "terminal_already_absent"
  | "indexing_failed"
  | "dispatch_failed"
  | "pending_replay"
  | "superseded"
  | "ineligible"
  | "unsupported_contact"
  | "safety_boundary"
  | "unverified";

/** Short aliases for callers that do not need the storage-oriented name. */
export type CallbackOutcomeCategory = CallbackHistoryOutcomeCategory;
export type CallbackOutcomeReason = CallbackHistoryOutcomeReason;

export interface CallbackHistoryOutcome {
  category: CallbackHistoryOutcomeCategory;
  reason: CallbackHistoryOutcomeReason;
  indexedJobs?: number;
  changedJobs?: number;
}

export const DEFAULT_CALLBACK_HISTORY_OUTCOME: CallbackHistoryOutcome = {
  category: "deferred",
  reason: "unverified",
};

const CATEGORIES = new Set<CallbackHistoryOutcomeCategory>([
  "applied_indexed",
  "terminal_no_history",
  "coalesced",
  "deferred",
  "failed",
]);

const REASONS = new Set<CallbackHistoryOutcomeReason>([
  "indexed",
  "no_jobs",
  "open_work_order",
  "missing_vin",
  "vehicle_snapshot",
  "terminal_applied",
  "terminal_already_absent",
  "indexing_failed",
  "dispatch_failed",
  "pending_replay",
  "superseded",
  "ineligible",
  "unsupported_contact",
  "safety_boundary",
  "unverified",
]);

// These are local client admission guards, not provider/relay failures. Keep
// this exact allowlist in sync with client.ts; never match generic timeout,
// deadline, HTTP, or connection-error substrings here.
const SAFETY_BOUNDARY_MESSAGES = new Set([
  "callback deadline expired before transport lease",
  "callback transport deadline expired",
  "callback transport deadline expired during retry backoff",
  "callback transport blocked: callback_canary_expired",
  "callback transport blocked: timed_trial_not_active",
  "callback transport blocked: service_disabled",
  "callback transport blocked: denied_instance",
  "Protractor callback deadline expired before admission",
  "Protractor fleet transport admission deadline expired",
  "Protractor fleet transport pacer deadline expired",
  "Protractor rate-limit admission deadline expired",
  "Protractor callback deadline expired before transport",
  "Protractor circuit-breaker admission deadline expired",
  "Protractor fleet lease confirmation deadline expired",
  "Protractor fleet transport lease lost before dispatch",
  "Protractor callback deadline expired before dispatch",
  "Protractor outbound trial policy is not active",
  "Protractor outbound API calls are temporarily disabled",
  "Protractor outbound denied by local instance policy",
  "Protractor outbound is restricted to the callback canary",
]);

export function isCallbackSafetyBoundary(error: unknown): boolean {
  const message = error instanceof Error ? error.message : error;
  if (typeof message !== "string") return false;
  // Drain adds context to the client's result.error without changing its value.
  const localMessage = message.replace(
    /^(Vehicle|Work-order) callback replay failed: /,
    "",
  );
  return SAFETY_BOUNDARY_MESSAGES.has(localMessage);
}

function boundedCount(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return undefined;
  return value;
}

/**
 * Validate an outcome read from storage.  `null` means the row predates
 * callback outcome recording (or contains an untrusted/malformed value).
 * In particular, callers must not infer a successful application for legacy
 * rows just because `processed` is true.
 */
export function parseCallbackHistoryOutcome(value: unknown): CallbackHistoryOutcome | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.category !== "string" ||
    !CATEGORIES.has(candidate.category as CallbackHistoryOutcomeCategory) ||
    typeof candidate.reason !== "string" ||
    !REASONS.has(candidate.reason as CallbackHistoryOutcomeReason)
  ) return null;
  const indexedJobs = boundedCount(candidate.indexedJobs);
  const changedJobs = boundedCount(candidate.changedJobs);
  return {
    category: candidate.category as CallbackHistoryOutcomeCategory,
    reason: candidate.reason as CallbackHistoryOutcomeReason,
    ...(indexedJobs === undefined ? {} : { indexedJobs }),
    ...(changedJobs === undefined ? {} : { changedJobs }),
  };
}

/**
 * Normalize a caller-provided outcome before persistence.  Outcome writes
 * never carry arbitrary provider strings or unbounded counters.
 */
export function normalizeCallbackHistoryOutcome(
  value: unknown,
  fallback: CallbackHistoryOutcome = DEFAULT_CALLBACK_HISTORY_OUTCOME,
): CallbackHistoryOutcome {
  return parseCallbackHistoryOutcome(value) ??
    parseCallbackHistoryOutcome(fallback) ??
    { ...DEFAULT_CALLBACK_HISTORY_OUTCOME };
}

export function isCallbackHistoryOutcome(value: unknown): value is CallbackHistoryOutcome {
  return parseCallbackHistoryOutcome(value) !== null;
}
