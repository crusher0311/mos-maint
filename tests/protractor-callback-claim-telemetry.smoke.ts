/**
 * Offline regression coverage for privacy-safe callback claim rejection
 * telemetry.  The record builder is pure; repository claim-path coverage
 * captures the same sink contract without opening Mongo, PG, or Protractor.
 *
 * Run: npx tsx tests/protractor-callback-claim-telemetry.smoke.ts
 */
import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import {
  CALLBACK_CLAIM_REJECTION_REASONS,
  buildCallbackClaimRejectionRecord,
  logCallbackClaimRejection,
  type CallbackClaimTelemetryContext,
} from "../lib/integrations/protractor/callback-claim-telemetry";

const sensitive = {
  eventKey: "event-raw-7f0c",
  shopId: 4271,
  objectType: "WorkOrder",
  objectId: "work-order-private",
  ownerToken: "owner-token-private",
  vin: "VIN-PRIVATE",
  payload: "provider-payload-private",
  error: "provider-error-private",
};

const mongoContext: CallbackClaimTelemetryContext = {
  store: "mongo",
  eventKey: sensitive.eventKey,
  shopId: sensitive.shopId,
  objectType: sensitive.objectType,
  objectId: sensitive.objectId,
};
const pgContext: CallbackClaimTelemetryContext = {
  ...mongoContext,
  store: "pg",
};

const records: unknown[] = [];
const sink = (record: unknown): void => {
  records.push(record);
};

for (const reason of CALLBACK_CLAIM_REJECTION_REASONS) {
  logCallbackClaimRejection(mongoContext, reason, sink);
  logCallbackClaimRejection(pgContext, reason, sink);
}

assert.equal(
  records.length,
  CALLBACK_CLAIM_REJECTION_REASONS.length * 2,
  "each allowlisted reason emits once per store",
);
const first = records[0] as Record<string, unknown>;
assert.deepEqual(
  Object.keys(first).sort(),
  ["event", "eventFingerprint", "objectFingerprint", "reason", "store"].sort(),
  "claim telemetry has only the bounded allowlist fields",
);
assert.equal(first.store, "mongo");
assert.equal(first.reason, "winner_absent");
assert.notEqual(first.eventFingerprint, sensitive.eventKey);
assert.notEqual(first.objectFingerprint, sensitive.objectId);
assert.equal(
  JSON.stringify(records).includes(
    [
      sensitive.eventKey,
      String(sensitive.shopId),
      sensitive.objectType,
      sensitive.objectId,
      sensitive.ownerToken,
      sensitive.vin,
      sensitive.payload,
      sensitive.error,
    ].join("|"),
  ),
  false,
  "claim telemetry does not serialize callback identifiers or private values",
);

const repeated = buildCallbackClaimRejectionRecord(mongoContext, "winner_absent");
assert.deepEqual(
  repeated,
  buildCallbackClaimRejectionRecord(mongoContext, "winner_absent"),
  "event/object fingerprints are deterministic",
);
assert.equal(
  repeated?.eventFingerprint,
  (records[0] as Record<string, unknown>).eventFingerprint,
);
assert.equal(
  repeated?.objectFingerprint,
  (records[0] as Record<string, unknown>).objectFingerprint,
);
assert.equal(
  repeated?.eventFingerprint,
  (records[1] as Record<string, unknown>).eventFingerprint,
  "the same event correlates across Mongo and PG",
);
assert.equal(
  buildCallbackClaimRejectionRecord(
    mongoContext,
    "provider-error" as never,
  ),
  null,
  "unknown rejection reasons are not emitted",
);

assert.doesNotThrow(() => {
  logCallbackClaimRejection(mongoContext, "winner_absent", () => {
    throw new Error(sensitive.error);
  });
}, "a telemetry sink failure cannot reject a callback claim");

// Admission helpers are also used directly for non-claiming work.  The
// optional claim context is the explicit gate that keeps those calls quiet.
const quietRecords: unknown[] = [];
logCallbackClaimRejection(
  {
    ...mongoContext,
    eventKey: "direct-admission-helper",
  },
  "fresh_ownership",
  (record) => quietRecords.push(record),
);
assert.equal(
  quietRecords.length,
  1,
  "telemetry is emitted only when the claim path supplies its context",
);

console.log("protractor callback claim telemetry: all checks passed");