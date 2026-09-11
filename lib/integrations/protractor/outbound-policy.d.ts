export type ProtractorOutboundPolicyReason =
  | "allowed"
  | "service_disabled"
  | "denied_instance"
  | "malformed_policy"
  | "missing_identity"
  | "malformed_callback_trial_flag"
  | "conflicting_callback_trial_policy"
  | "malformed_callback_canary"
  | "missing_callback_replay_floor"
  | "malformed_callback_replay_floor"
  | "future_callback_replay_floor"
  | "stale_callback_replay_floor"
  | "callback_canary_too_long"
  | "callback_canary_expired"
  | "timed_trial_state_unavailable"
  | "timed_trial_not_active";

export interface ProtractorOutboundPolicyDecision {
  allowed: boolean;
  reason: ProtractorOutboundPolicyReason;
  identity: string | null;
  callbackOnly?: boolean;
  requireTimedTrial?: boolean;
  callbackNotBeforeMs?: number | null;
}

export const DENY_ENV: "PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS";
export const CALLBACK_CANARY_UNTIL_ENV: "PROTRACTOR_CALLBACK_CANARY_UNTIL";
export const CALLBACK_REPLAY_NOT_BEFORE_ENV: "PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE";
export const CALLBACK_TRIAL_ENABLED_ENV: "PROTRACTOR_CALLBACK_TRIAL_ENABLED";
export function evaluateProtractorOutboundPolicy(
  env: Record<string, string | undefined>,
  nowMs?: number,
): ProtractorOutboundPolicyDecision;
export function resolveInstanceIdentity(
  env: Record<string, string | undefined>,
): string | null;
export function fingerprintInstance(identity: string | null): string;
export function logProtractorPolicyDenial(
  decision: ProtractorOutboundPolicyDecision,
  context: string,
): void;