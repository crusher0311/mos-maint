/**
 * Privacy-safe telemetry for rejected Protractor callback claims.
 *
 * Claim rejection is intentionally separate from callback history: a rejected
 * claim does not change the callback row, and this module must not add another
 * read or write to the claim path.  Only allowlisted reasons and deterministic
 * one-way fingerprints cross the logging boundary.  In particular, event
 * keys, object ids, shop ids, owner tokens, VINs, provider payloads, and error
 * strings are never emitted.
 */
import { createHash } from "node:crypto";

export const CALLBACK_CLAIM_REJECTION_REASONS = [
  "winner_absent",
  "winner_mismatch",
  "fresh_ownership",
  "candidate_unavailable",
  "winner_changed",
  "coordinator_fence",
  "event_fence",
] as const;

export type CallbackClaimRejectionReason =
  (typeof CALLBACK_CLAIM_REJECTION_REASONS)[number];

export type CallbackClaimTelemetryStore = "mongo" | "pg";

export interface CallbackClaimTelemetryContext {
  store: CallbackClaimTelemetryStore;
  eventKey: string;
  shopId: number;
  objectType: string;
  objectId: string;
}

export interface CallbackClaimRejectionRecord {
  event: "protractor_callback_claim_rejected";
  store: CallbackClaimTelemetryStore;
  reason: CallbackClaimRejectionReason;
  eventFingerprint: string;
  objectFingerprint: string;
}

const REASONS = new Set<string>(CALLBACK_CLAIM_REJECTION_REASONS);

function hash(value: string): string {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Return a stable fingerprint for an opaque callback event key.
 *
 * Domain separation keeps event and object fingerprints from being
 * interchangeable even when their source strings happen to match.
 */
export function fingerprintCallbackEvent(eventKey: string): string {
  return hash(`protractor-callback-claim:event:${eventKey}`);
}

/** Return a stable fingerprint for the callback's shop/object identity. */
export function fingerprintCallbackObject(
  shopId: number,
  objectType: string,
  objectId: string,
): string {
  return hash(JSON.stringify([
    "protractor-callback-claim:object",
    shopId,
    objectType,
    objectId,
  ]));
}

function validContext(
  context: CallbackClaimTelemetryContext,
): boolean {
  return (
    (context.store === "mongo" || context.store === "pg") &&
    typeof context.eventKey === "string" &&
    typeof context.objectType === "string" &&
    typeof context.objectId === "string" &&
    Number.isSafeInteger(context.shopId)
  );
}

/**
 * Pure record builder used by the store claim paths and its regression tests.
 * Returning null for malformed input is deliberate: malformed telemetry must
 * not become a callback-processing failure.
 */
export function buildCallbackClaimRejectionRecord(
  context: CallbackClaimTelemetryContext,
  reason: CallbackClaimRejectionReason,
): CallbackClaimRejectionRecord | null {
  try {
    if (!validContext(context) || !REASONS.has(reason)) return null;
    return {
      event: "protractor_callback_claim_rejected",
      store: context.store,
      reason,
      eventFingerprint: fingerprintCallbackEvent(context.eventKey),
      objectFingerprint: fingerprintCallbackObject(
        context.shopId,
        context.objectType,
        context.objectId,
      ),
    };
  } catch {
    return null;
  }
}

type CallbackClaimTelemetrySink = (record: CallbackClaimRejectionRecord) => void;

function defaultSink(record: CallbackClaimRejectionRecord): void {
  try {
    console.warn("[ProtractorCallbackClaimRejection]", JSON.stringify(record));
  } catch {
    // Telemetry is non-critical and must never affect callback processing.
  }
}

/**
 * Emit one rejected-claim record.  This is intentionally fail-safe: logger
 * and serialization failures are swallowed so telemetry cannot alter claim
 * return values, cleanup, retries, or release ordering.
 */
export function logCallbackClaimRejection(
  context: CallbackClaimTelemetryContext,
  reason: CallbackClaimRejectionReason,
  sink: CallbackClaimTelemetrySink = defaultSink,
): void {
  try {
    const record = buildCallbackClaimRejectionRecord(context, reason);
    if (record) sink(record);
  } catch {
    // A logger/transport failure is not a callback claim failure.
  }
}