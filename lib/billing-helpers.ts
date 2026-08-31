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
