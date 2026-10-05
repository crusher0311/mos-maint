/**
 * Automatic audit receipts require an actually verified webhook signature.
 * Routes may keep their legacy permissive delivery posture while signature
 * rollout is incomplete, but an unsigned payload must not create audit work.
 */
export function mayScheduleVerifiedWebhookAudit(
  signingSecret: string | undefined,
  signatureError: string | null,
): boolean {
  return Boolean(signingSecret) && signatureError === null;
}