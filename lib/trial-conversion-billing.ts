/**
 * Helpers for billing failures on trial-converted Stripe subscriptions.
 *
 * The trial-check cron (`app/api/cron/trial-check/route.ts`) creates these
 * subs when a trial expires with a card on file and stamps
 * `metadata.convertedFromTrial = "true"`. The webhook
 * (`app/api/stripe/webhook/route.ts`) uses the helpers here to track
 * failures, decide when to suspend, and clamp the configurable retry
 * ceiling so a misconfiguration can't suspend shops on the first failure.
 */

export const DEFAULT_TRIAL_CONVERSION_MAX_PAYMENT_RETRIES = 3;

export function isTrialConvertedSubscription(
  metadata: Record<string, string> | null | undefined,
): boolean {
  return metadata?.convertedFromTrial === "true";
}

export type TrialConversionFailureDecision = {
  failureCount: number;
  maxRetries: number;
  isFirstFailure: boolean;
  shouldSuspend: boolean;
  attemptsRemaining: number;
};

export function evaluateTrialConversionFailure(
  prevFailureCount: number | null | undefined,
  maxRetries: number | null | undefined,
): TrialConversionFailureDecision {
  const safeMax = Math.max(
    1,
    Math.floor(Number(maxRetries) || 0) ||
      DEFAULT_TRIAL_CONVERSION_MAX_PAYMENT_RETRIES,
  );
  const prev = Math.max(0, Math.floor(Number(prevFailureCount) || 0));
  const failureCount = prev + 1;
  return {
    failureCount,
    maxRetries: safeMax,
    isFirstFailure: failureCount === 1,
    shouldSuspend: failureCount >= safeMax,
    attemptsRemaining: Math.max(0, safeMax - failureCount),
  };
}
