/**
 * Offline coverage for the pure, opted-in callback-normalization timing
 * summary.  This test never imports a database or provider client.
 *
 * Run:
 * NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' \
 * PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
 * npx tsx tests/protractor-callback-normalization-timing.smoke.ts
 */

import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createNormalizationTimingRecorder,
  normalizationWriteTimingOperation,
} from "../lib/integrations/core/normalization-timing";

type RecordValue = Record<string, any>;

async function main(): Promise<void> {
let now = 1_000;
const records: RecordValue[] = [];
const recorder = createNormalizationTimingRecorder(
  () => now,
  (record) => records.push(record),
);

const vehicleStart = recorder.start("vehicle_resolution");
now += 11;
recorder.finish("vehicle_resolution", vehicleStart, "success");
const secondVehicleStart = recorder.start("vehicle_resolution");
now += 4;
recorder.finish("vehicle_resolution", secondVehicleStart, "success");

now += 3;
await recorder.measure(
  "line_item",
  async () => {
    now += 7;
    return { success: false };
  },
);

await assert.rejects(
  recorder.measure("payment", async () => {
    now += 5;
    throw new Error("private provider error must not be logged");
  }),
);

now += 2;
await recorder.measure("repair_patterns", async () => {
  now += 6;
  return false;
});
recorder.mark("repair_patterns", 19, "skipped");
recorder.finalize("failed");
recorder.finalize("success");

assert.equal(records.length, 1, "finalize emits exactly one summary");
assert.deepEqual(records[0], {
  kind: "callback_normalization_timing",
  wallTimeMs: 38,
  nestedOperationTotals: true,
  outcome: "failed",
  operations: [
    {
      operation: "vehicle_resolution",
      count: 2,
      failedCount: 0,
      skippedCount: 0,
      totalMs: 15,
      maxMs: 11,
    },
    {
      operation: "line_item",
      count: 1,
      failedCount: 1,
      skippedCount: 0,
      totalMs: 7,
      maxMs: 7,
    },
    {
      operation: "payment",
      count: 1,
      failedCount: 1,
      skippedCount: 0,
      totalMs: 5,
      maxMs: 5,
    },
    {
      operation: "repair_patterns",
      count: 2,
      failedCount: 1,
      skippedCount: 1,
      totalMs: 25,
      maxMs: 19,
    },
  ],
});

assert.equal(
  JSON.stringify(records).includes("private provider error"),
  false,
  "thrown error text is not included in the summary",
);
assert.equal(
  JSON.stringify(records).includes("VIN-SECRET/shop-secret"),
  false,
  "callback identity fields are not included in the summary",
);
assert.equal(
  normalizationWriteTimingOperation("work_order", "canonical"),
  "work_order_canonical_write",
);
assert.equal(
  normalizationWriteTimingOperation("customer", "mirror"),
  "customer_mirror_write",
);
assert.equal(
  normalizationWriteTimingOperation("untrusted-entity", "canonical"),
  "work_order_canonical_write",
  "unknown entity names cannot become telemetry fields",
);

const loggerFailureRecords: RecordValue[] = [];
const loggerFailureRecorder = createNormalizationTimingRecorder(
  () => 5_000,
  () => {
    throw new Error("logger failure");
  },
);
await loggerFailureRecorder.measure("audit_write", async () => {
  loggerFailureRecords.push({ processing: "continued" });
  return { success: true };
});
loggerFailureRecorder.finalize("success");
assert.deepEqual(loggerFailureRecords, [{ processing: "continued" }]);

const clockFailureRecorder = createNormalizationTimingRecorder(
  () => {
    throw new Error("clock failure");
  },
  (record) => records.push(record),
);
await clockFailureRecorder.measure("aces_decode", async () => ({ success: false }));
clockFailureRecorder.finalize("failed");
const clockFailureRecord = records.at(-1);
assert.equal(clockFailureRecord?.operations[0]?.failedCount, 1);
assert.equal(clockFailureRecord?.wallTimeMs, 0);

const callbackDrainSource = readFileSync(
  new URL("../lib/integrations/protractor/callback-drain.ts", import.meta.url),
  "utf8",
);
const ingestionSource = readFileSync(
  new URL("../lib/integrations/core/normalized-ingestion.ts", import.meta.url),
  "utf8",
);
assert.match(
  callbackDrainSource,
  /createNormalizationTimingRecorder/,
  "the callback drain owns the opt-in recorder",
);
assert.match(
  callbackDrainSource,
  /callbackNormalizationTiming:\s*normalizationTiming/,
  "the callback drain passes the recorder to all-entity ingestion",
);
assert.match(
  callbackDrainSource,
  /normalizationTiming\?\.finalize/,
  "normalization timing finalizes in the failure-safe path",
);
assert.doesNotMatch(
  ingestionSource,
  /createNormalizationTimingRecorder/,
  "normalized ingestion does not opt providers in by itself",
);

console.log("protractor callback normalization timing: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});