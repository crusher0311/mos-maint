export type BillingLike = {
  plan?: string | null;
  paymentType?: string | null;
  [key: string]: any;
} | null | undefined;

export function isInvoiceBilled(billing: BillingLike): boolean {
  if (!billing) return false;
  if (billing.paymentType === "invoice") return true;
  return false;
}

export function resolvePaymentType(billing: BillingLike): "stripe" | "invoice" {
  return isInvoiceBilled(billing) ? "invoice" : "stripe";
}
