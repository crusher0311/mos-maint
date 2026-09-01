export type ProtractorOutboundPolicyReason =
  | "allowed"
  | "service_disabled"
  | "denied_instance"
  | "malformed_policy"
  | "missing_identity";

export interface ProtractorOutboundPolicyDecision {
  allowed: boolean;
  reason: ProtractorOutboundPolicyReason;
  identity: string | null;
}

export const DENY_ENV: "PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS";
export function evaluateProtractorOutboundPolicy(
  env: Record<string, string | undefined>,
): ProtractorOutboundPolicyDecision;
export function resolveInstanceIdentity(
  env: Record<string, string | undefined>,
): string | null;
export function fingerprintInstance(identity: string | null): string;
export function logProtractorPolicyDenial(
  decision: ProtractorOutboundPolicyDecision,
  context: string,
): void;