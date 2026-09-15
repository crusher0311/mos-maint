/**
 * Privacy-safe runtime timing for the Protractor callback drain.
 *
 * This module deliberately owns the telemetry boundary.  Callers provide only
 * allowlisted stage/outcome values and this module emits no callback identity,
 * shop, provider, vehicle, payload, or error fields.  A logger failure is
 * ignored so observability can never change queue behavior.
 *
 * The dispatch stage encloses the callback's nested client fetch and local
 * snapshot/normalization work.  Stage timings are therefore nested and
 * intentionally non-additive.
 */

export const CALLBACK_TIMING_STAGES = [
  "selection",
  "claim",
  "eligibility",
  "dispatch",
  "fetch",
  "snapshot",
  "normalization",
  "indexing",
  "attribution",
  "secondary_work",
  "completion",
  "total",
] as const;

export type CallbackTimingStage = (typeof CALLBACK_TIMING_STAGES)[number];

export const CALLBACK_TIMING_OUTCOMES = [
  "success",
  "failed",
  "deferred",
  "skipped",
  "not_run",
] as const;

export type CallbackTimingOutcome = (typeof CALLBACK_TIMING_OUTCOMES)[number];

export const CALLBACK_BATCH_EXIT_REASONS = [
  "completed",
  "empty",
  "deadline",
  "budget_unavailable",
  "policy_denied",
  "relay_unavailable",
  "failed",
] as const;

export type CallbackBatchExitReason = (typeof CALLBACK_BATCH_EXIT_REASONS)[number];

const STAGES = new Set<string>(CALLBACK_TIMING_STAGES);
const OUTCOMES = new Set<string>(CALLBACK_TIMING_OUTCOMES);
const EXIT_REASONS = new Set<string>(CALLBACK_BATCH_EXIT_REASONS);

// Queue work is bounded to 180s by default, but keep a generous fixed cap so
// an accidentally unbounded clock or a malformed test cannot produce an
// unbounded telemetry value.
const MAX_ELAPSED_MS = 15 * 60 * 1000;
const MAX_COUNT = 5_000;

export interface CallbackStageTimingRecord {
  kind: "callback_stage_timing";
  stage: CallbackTimingStage;
  elapsedMs: number;
  outcome: CallbackTimingOutcome;
}

export interface CallbackBatchTimingRecord {
  kind: "callback_batch_timing";
  durationMs: number;
  candidateCount: number;
  selectedCount: number;
  /** In-memory duplicate candidates collapsed during batch selection. */
  selectionCollapsedCount: number;
  processed: number;
  failed: number;
  exitReason: CallbackBatchExitReason;
}

type TimingSink = (record: CallbackStageTimingRecord | CallbackBatchTimingRecord) => void;

function boundedElapsedMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_ELAPSED_MS, Math.round(value)));
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_COUNT, Math.floor(value)));
}

function defaultSink(record: CallbackStageTimingRecord | CallbackBatchTimingRecord): void {
  // JSON keeps this record visibly bounded and prevents an object supplied by
  // a caller from being rendered by a logger with additional properties.
  try {
    console.info("[ProtractorCallbackTiming]", JSON.stringify(record));
  } catch {
    // Telemetry is non-critical and must never affect callback processing.
  }
}

function emit(
  record: CallbackStageTimingRecord | CallbackBatchTimingRecord,
  sink: TimingSink,
): void {
  try {
    sink(record);
  } catch {
    // A logger/transport failure is not a callback processing failure.
  }
}

function safeStage(value: CallbackTimingStage): CallbackTimingStage | null {
  return STAGES.has(value) ? value : null;
}

function safeOutcome(value: CallbackTimingOutcome): CallbackTimingOutcome | null {
  return OUTCOMES.has(value) ? value : null;
}

function safeExitReason(value: CallbackBatchExitReason): CallbackBatchExitReason | null {
  return EXIT_REASONS.has(value) ? value : null;
}

export interface CallbackTimingRecorder {
  start(stage: Exclude<CallbackTimingStage, "total">): number;
  finish(
    stage: Exclude<CallbackTimingStage, "total">,
    startedAt: number,
    outcome: CallbackTimingOutcome,
  ): void;
  mark(
    stage: Exclude<CallbackTimingStage, "total">,
    elapsedMs: number,
    outcome: CallbackTimingOutcome,
  ): void;
  finalize(outcome: CallbackTimingOutcome): void;
}

/**
 * Create one recorder per callback.  Stages are emitted from finalize(), so
 * every path (including a thrown failure) has a total and has explicit
 * not_run entries for stages that were not reached.
 */
export function createCallbackTimingRecorder(
  now: () => number = Date.now,
  sink: TimingSink = defaultSink,
): CallbackTimingRecorder {
  const startedAt = now();
  const stages = new Map<Exclude<CallbackTimingStage, "total">, {
    elapsedMs: number;
    outcome: CallbackTimingOutcome;
  }>();
  let finalized = false;

  const record = (
    stage: Exclude<CallbackTimingStage, "total">,
    elapsedMs: number,
    outcome: CallbackTimingOutcome,
  ): void => {
    if (finalized || !safeStage(stage) || !safeOutcome(outcome)) {
      return;
    }
    if (stages.has(stage)) return;
    stages.set(stage, { elapsedMs: boundedElapsedMs(elapsedMs), outcome });
  };

  return {
    start: () => now(),
    finish: (stage, stageStartedAt, outcome) => {
      record(stage, now() - stageStartedAt, outcome);
    },
    mark: (stage, elapsedMs, outcome) => {
      record(stage, elapsedMs, outcome);
    },
    finalize: (outcome) => {
      if (finalized) return;
      finalized = true;
      const finalOutcome = safeOutcome(outcome) ?? "failed";
      const itemStages: Array<Exclude<CallbackTimingStage, "total">> = [
        "claim",
        "eligibility",
        "dispatch",
        "fetch",
        "snapshot",
        "normalization",
        "indexing",
        "attribution",
        "secondary_work",
        "completion",
      ];
      for (const stage of itemStages) {
        if (!stages.has(stage)) {
          stages.set(stage, { elapsedMs: 0, outcome: "not_run" });
        }
      }
      for (const stage of itemStages) {
        const timing = stages.get(stage)!;
        emit({
          kind: "callback_stage_timing",
          stage,
          elapsedMs: boundedElapsedMs(timing.elapsedMs),
          outcome: timing.outcome,
        }, sink);
      }
      emit({
        kind: "callback_stage_timing",
        stage: "total",
        elapsedMs: boundedElapsedMs(now() - startedAt),
        outcome: finalOutcome,
      }, sink);
    },
  };
}

/**
 * Emit a batch-level stage (currently selection).  This is intentionally
 * separate from a callback recorder because selection happens once per batch.
 */
export function emitCallbackStageTiming(
  stage: CallbackTimingStage,
  elapsedMs: number,
  outcome: CallbackTimingOutcome,
  sink: TimingSink = defaultSink,
): void {
  const safeStageValue = safeStage(stage);
  const safeOutcomeValue = safeOutcome(outcome);
  if (!safeStageValue || !safeOutcomeValue) return;
  emit({
    kind: "callback_stage_timing",
    stage: safeStageValue,
    elapsedMs: boundedElapsedMs(elapsedMs),
    outcome: safeOutcomeValue,
  }, sink);
}

export function emitCallbackBatchTiming(
  input: {
    durationMs: number;
    candidateCount: number;
    selectedCount: number;
    selectionCollapsedCount: number;
    processed: number;
    failed: number;
    exitReason: CallbackBatchExitReason;
  },
  sink: TimingSink = defaultSink,
): void {
  const exitReason = safeExitReason(input.exitReason);
  if (!exitReason) return;
  emit({
    kind: "callback_batch_timing",
    durationMs: boundedElapsedMs(input.durationMs),
    candidateCount: boundedCount(input.candidateCount),
    selectedCount: boundedCount(input.selectedCount),
    selectionCollapsedCount: boundedCount(input.selectionCollapsedCount),
    processed: boundedCount(input.processed),
    failed: boundedCount(input.failed),
    exitReason,
  }, sink);
}
