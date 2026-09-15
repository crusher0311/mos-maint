/**
 * Pure, bounded timing summaries for an explicitly opted-in ingestion call.
 *
 * This module has no database, provider, or logger dependencies.  The
 * Protractor callback drain is currently the only caller that opts in.  Keep
 * the summary deliberately small: operation names are an allowlist and no
 * caller-provided text is ever copied into a record.
 *
 * Operation timings are nested inside the callback's normalization wall time.
 * In particular, child writes can overlap, so operation totals are not
 * additive and must not be compared with wall time as if they were a trace.
 */

export const NORMALIZATION_TIMING_OPERATIONS = [
  "vehicle_resolution",
  "customer_resolution",
  "work_order_resolution",
  "vehicle_pg_natural_key_read",
  "vehicle_mongo_natural_key_read",
  "customer_pg_natural_key_read",
  "customer_mongo_natural_key_read",
  "work_order_pg_natural_key_read",
  "work_order_mongo_natural_key_read",
  "service_job_pg_natural_key_read",
  "service_job_mongo_natural_key_read",
  "line_item_pg_natural_key_read",
  "line_item_mongo_natural_key_read",
  "payment_pg_natural_key_read",
  "payment_mongo_natural_key_read",
  "post_parent_vehicle_fk_pg_read",
  "post_parent_vehicle_fk_mongo_read",
  "vehicle_canonical_write",
  "vehicle_mirror_write",
  "customer_canonical_write",
  "customer_mirror_write",
  "work_order_canonical_write",
  "work_order_mirror_write",
  "service_job_canonical_write",
  "service_job_mirror_write",
  "line_item_canonical_write",
  "line_item_mirror_write",
  "payment_canonical_write",
  "payment_mirror_write",
  "inspection_canonical_write",
  "inspection_mirror_write",
  "recommendation_canonical_write",
  "recommendation_mirror_write",
  "service_job",
  "line_item",
  "payment",
  "inspection",
  "recommendation",
  "audit_write",
  "ingestion_stamp",
  "aces_decode",
  "job_index_lookup",
  "job_index_write",
  "repair_patterns",
] as const;

export type NormalizationTimingOperation =
  (typeof NORMALIZATION_TIMING_OPERATIONS)[number];

export const NORMALIZATION_TIMING_OUTCOMES = [
  "success",
  "failed",
  "skipped",
] as const;

export type NormalizationTimingOutcome =
  (typeof NORMALIZATION_TIMING_OUTCOMES)[number];

export interface NormalizationOperationTimingSummary {
  operation: NormalizationTimingOperation;
  count: number;
  failedCount: number;
  skippedCount: number;
  totalMs: number;
  maxMs: number;
}

export interface NormalizationTimingRecord {
  kind: "callback_normalization_timing";
  /**
   * Wall time from recorder creation through finalize(). Operation totals are
   * nested within this interval and are explicitly non-additive.
   */
  wallTimeMs: number;
  nestedOperationTotals: true;
  outcome: NormalizationTimingOutcome;
  operations: NormalizationOperationTimingSummary[];
}

type TimingSink = (record: NormalizationTimingRecord) => void;
type TimedResult =
  | { success?: unknown; action?: unknown }
  | boolean
  | null
  | undefined;

const OPERATIONS = new Set<string>(NORMALIZATION_TIMING_OPERATIONS);
const OUTCOMES = new Set<string>(NORMALIZATION_TIMING_OUTCOMES);

// Keep values bounded even if a clock or test seam behaves unexpectedly.
const MAX_ELAPSED_MS = 15 * 60 * 1000;
const MAX_COUNT = 5_000;

function boundedElapsedMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_ELAPSED_MS, Math.round(value)));
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_COUNT, Math.floor(value)));
}

function safeNow(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? value : 0;
  } catch {
    // Clock failures are telemetry failures, not ingestion failures.
    return 0;
  }
}

function safeOutcome(
  outcome: NormalizationTimingOutcome,
): NormalizationTimingOutcome {
  return OUTCOMES.has(outcome) ? outcome : "failed";
}

function inferOutcome(value: unknown): NormalizationTimingOutcome {
  try {
    if (value === false) return "failed";
    if (
      value &&
      typeof value === "object" &&
      "success" in value &&
      (value as { success?: unknown }).success === false
    ) {
      return "failed";
    }
    if (
      value &&
      typeof value === "object" &&
      (value as { action?: unknown }).action === "skipped"
    ) {
      return "skipped";
    }
  } catch {
    // A result inspection failure must not change the wrapped operation.
  }
  return "success";
}

function defaultSink(record: NormalizationTimingRecord): void {
  try {
    console.info(
      "[ProtractorCallbackNormalizationTiming]",
      JSON.stringify(record),
    );
  } catch {
    // A logger/serialization failure can never affect ingestion.
  }
}

function emit(record: NormalizationTimingRecord, sink: TimingSink): void {
  try {
    sink(record);
  } catch {
    // Observability is deliberately outside callback processing semantics.
  }
}

export interface NormalizationTimingRecorder {
  start(operation: NormalizationTimingOperation): number;
  finish(
    operation: NormalizationTimingOperation,
    startedAt: number,
    outcome: NormalizationTimingOutcome,
  ): void;
  mark(
    operation: NormalizationTimingOperation,
    elapsedMs: number,
    outcome: NormalizationTimingOutcome,
  ): void;
  measure<T>(
    operation: NormalizationTimingOperation,
    work: () => Promise<T>,
    outcomeForResult?: (value: T) => NormalizationTimingOutcome,
  ): Promise<T>;
  finalize(outcome: NormalizationTimingOutcome): void;
}

/**
 * Create one recorder for one opted-in normalization attempt.
 *
 * The implementation intentionally records only completed operation calls.
 * `finalize()` emits one bounded aggregate record, including when the caller
 * catches a thrown operation and supplies `failed` or `skipped`.
 */
export function createNormalizationTimingRecorder(
  now: () => number = Date.now,
  sink: TimingSink = defaultSink,
): NormalizationTimingRecorder {
  const startedAt = safeNow(now);
  const summaries = new Map<
    NormalizationTimingOperation,
    NormalizationOperationTimingSummary
  >();
  let finalized = false;

  const record = (
    operation: NormalizationTimingOperation,
    elapsedMs: number,
    outcome: NormalizationTimingOutcome,
  ): void => {
    if (finalized || !OPERATIONS.has(operation)) return;
    const prior = summaries.get(operation) ?? {
      operation,
      count: 0,
      failedCount: 0,
      skippedCount: 0,
      totalMs: 0,
      maxMs: 0,
    };
    if (prior.count >= MAX_COUNT) return;

    const duration = boundedElapsedMs(elapsedMs);
    prior.count = boundedCount(prior.count + 1);
    if (outcome === "failed") {
      prior.failedCount = boundedCount(prior.failedCount + 1);
    } else if (outcome === "skipped") {
      prior.skippedCount = boundedCount(prior.skippedCount + 1);
    }
    prior.totalMs = boundedElapsedMs(prior.totalMs + duration);
    prior.maxMs = Math.max(prior.maxMs, duration);
    summaries.set(operation, prior);
  };

  return {
    start: () => safeNow(now),
    finish: (operation, operationStartedAt, outcome) => {
      if (!OUTCOMES.has(outcome)) return;
      record(operation, safeNow(now) - operationStartedAt, outcome);
    },
    mark: (operation, elapsedMs, outcome) => {
      if (!OUTCOMES.has(outcome)) return;
      record(operation, elapsedMs, outcome);
    },
    measure: async <T>(
      operation: NormalizationTimingOperation,
      work: () => Promise<T>,
      outcomeForResult?: (value: T) => NormalizationTimingOutcome,
    ): Promise<T> => {
      // Do not let a malformed operation supplied through a cast affect work.
      if (!OPERATIONS.has(operation)) return work();
      const operationStartedAt = safeNow(now);
      try {
        const result = await work();
        let outcome = inferOutcome(result as unknown as TimedResult);
        if (outcomeForResult) {
          try {
            outcome = safeOutcome(outcomeForResult(result));
          } catch {
            // An outcome mapper is telemetry code; use the safe inference.
          }
        }
        record(operation, safeNow(now) - operationStartedAt, outcome);
        return result;
      } catch (error) {
        record(operation, safeNow(now) - operationStartedAt, "failed");
        throw error;
      }
    },
    finalize: (outcome) => {
      if (finalized) return;
      finalized = true;
      const operations = [...summaries.values()].map((summary) => ({
        operation: summary.operation,
        count: boundedCount(summary.count),
        failedCount: boundedCount(summary.failedCount),
        skippedCount: boundedCount(summary.skippedCount),
        totalMs: boundedElapsedMs(summary.totalMs),
        maxMs: boundedElapsedMs(summary.maxMs),
      }));
      emit(
        {
          kind: "callback_normalization_timing",
          wallTimeMs: boundedElapsedMs(safeNow(now) - startedAt),
          nestedOperationTotals: true,
          outcome: safeOutcome(outcome),
          operations,
        },
        sink,
      );
    },
  };
}

/**
 * Map the stable entity names already used by normalized ingestion to the
 * corresponding allowlisted canonical/mirror operation. Unknown names never
 * become telemetry fields.
 */
export function normalizationWriteTimingOperation(
  entityType: string,
  kind: "canonical" | "mirror",
): NormalizationTimingOperation {
  const entity = new Set([
    "vehicle",
    "customer",
    "work_order",
    "service_job",
    "line_item",
    "payment",
    "inspection",
    "recommendation",
  ]).has(entityType)
    ? entityType
    : "work_order";
  const safeKind = kind === "mirror" ? "mirror" : "canonical";
  return `${entity}_${safeKind}_write` as NormalizationTimingOperation;
}