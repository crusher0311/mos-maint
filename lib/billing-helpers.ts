export type BillingLike = {
  plan?: string | null;
  paymentType?: string | null;
  status?: string | null;
  [key: string]: any;
} | null | undefined;

export type EffectiveBillingStatus =
  | "trial"
  | "trialing"
  | "active"
  | "past_due"
  | "suspended"
  | "canceled"
  | "paused"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "enterprise"
  | "demo";

const VALID_BILLING_STATUSES = new Set<EffectiveBillingStatus>([
  "trial",
  "trialing",
  "active",
  "past_due",
  "suspended",
  "canceled",
  "paused",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "enterprise",
  "demo",
]);

export function isInvoiceBilled(billing: BillingLike): boolean {
  if (!billing) return false;
  if (billing.paymentType === "invoice") return true;
  return false;
}

export function resolvePaymentType(billing: BillingLike): "stripe" | "invoice" {
  return isInvoiceBilled(billing) ? "invoice" : "stripe";
}

/**
 * Resolve the customer-visible/access-control status from the complete billing
 * record. Invoice accounts are not governed by stale Stripe cancellation
 * state, but explicit operational states still retain their meaning.
 */
export function resolveEffectiveBillingStatus(
  billing: BillingLike,
  fallback: EffectiveBillingStatus = "trial",
): EffectiveBillingStatus {
  const rawStatus = billing?.status;
  const status = VALID_BILLING_STATUSES.has(rawStatus as EffectiveBillingStatus)
    ? (rawStatus as EffectiveBillingStatus)
    : fallback;

  if (isInvoiceBilled(billing) && (status === "canceled" || !rawStatus)) {
    return "active";
  }

  return status;
}

export function isBillingStatusActive(status: EffectiveBillingStatus): boolean {
  return (
    status === "active" ||
    status === "trial" ||
    status === "trialing" ||
    status === "enterprise" ||
    status === "demo" ||
    status === "past_due"
  );
}

/** Nested deadline is authoritative when present, including malformed/null values.
 * Never fall back from a broken current deadline to a stale legacy grant.
 * Subscription IDs and cards on file are not evidence of payment.
 */
export function evaluateBillingEligibility(
  shop: { billing?: BillingLike; trial?: { endsAt?: unknown } | null; trialEndsAt?: unknown },
  now = Date.now(),
) {
  const status = resolveEffectiveBillingStatus(shop.billing);
  const isTrial = status === "trial" || status === "trialing";
  const raw = shop.trial && Object.prototype.hasOwnProperty.call(shop.trial, "endsAt")
    ? shop.trial.endsAt : shop.trialEndsAt;
  const deadline = raw instanceof Date ? raw.getTime()
    : typeof raw === "number" && Number.isFinite(raw) ? raw
    : typeof raw === "string" && raw.trim() ? Date.parse(raw) : NaN;
  const valid = Number.isFinite(deadline);
  const allowed = isTrial ? valid && now < deadline :
    isBillingStatusActive(status) && (isInvoiceBilled(shop.billing) || shop.billing?.subscriptionAccessConfirmed !== false);
  return {
    status, isTrial, allowed,
    eligibleUntil: isTrial && valid ? new Date(deadline).toISOString() : null,
    reason: allowed ? null : isTrial
      ? (valid ? "trial_expired" : "trial_eligibility_missing")
      : "subscription_blocked",
  };
}
