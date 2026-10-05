/**
 * Offline regression coverage for privacy-safe callback timing.
 *
 * Run:
 * NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' \
 * PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
 * npx tsx tests/protractor-callback-timing.smoke.ts
 */

import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import {
  createCallbackTimingRecorder,
  emitCallbackBatchTiming,
  emitCallbackStageTiming,
} from "../lib/integrations/protractor/callback-timing";

type RecordValue = Record<string, unknown>;

const records: RecordValue[] = [];
const sink = (record: RecordValue): void => {
  records.push(record);
};

let now = 10_000;
const recorder = createCallbackTimingRecorder(
  () => now,
  sink as any,
);

const dispatchStartedAt = recorder.start("dispatch");
now += 37;
recorder.finish("dispatch", dispatchStartedAt, "failed");
recorder.finalize("failed");

const stageRecords = records.filter((record) => record.kind === "callback_stage_timing");
assert.equal(stageRecords.length, 11, "all callback stages, including total, emit on failure");
assert.deepEqual(
  stageRecords.find((record) => record.stage === "dispatch"),
  {
    kind: "callback_stage_timing",
    stage: "dispatch",
    elapsedMs: 37,
    outcome: "failed",
  },
);
assert.deepEqual(
  stageRecords.find((record) => record.stage === "total"),
  {
    kind: "callback_stage_timing",
    stage: "total",
    elapsedMs: 37,
    outcome: "failed",
  },
);
assert.equal(
  JSON.stringify(records).includes("shop-secret/object-secret/VIN-SECRET/provider-error"),
  false,
  "timing records contain no callback identity or error text",
);

emitCallbackStageTiming(
  "selection",
  Number.POSITIVE_INFINITY,
  "success",
  sink as any,
);
emitCallbackStageTiming(
  "selection" as any,
  12,
  "provider-error" as any,
  sink as any,
);
emitCallbackBatchTiming({
  durationMs: Number.POSITIVE_INFINITY,
  candidateCount: 99_999,
  selectedCount: 99_999,
  selectionCollapsedCount: -4,
  processed: 99_999,
  failed: 99_999,
  exitReason: "completed",
}, sink as any);

const batchRecord = records.find((record) => record.kind === "callback_batch_timing");
assert.deepEqual(batchRecord, {
  kind: "callback_batch_timing",
  durationMs: 0,
  candidateCount: 5_000,
  selectedCount: 5_000,
  selectionCollapsedCount: 0,
  processed: 5_000,
  failed: 5_000,
  exitReason: "completed",
});
assert.equal(
  records.some((record) => record.outcome === "provider-error" || record.stage === "provider-error"),
  false,
  "unknown stage outcomes are rejected rather than logged",
);

console.log("protractor callback timing: all checks passed");
