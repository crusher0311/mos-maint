import { PLAN_FALLBACK_KEYS } from "./plan-feature-tiers";

/** Only configured price IDs establish a new purchased package. Unknown products
 * must not inherit a previous (possibly higher) plan or checkout metadata. */
export function planForSubscription(subscription: any, settings: any): string | null {
  const prices = new Set((subscription.items?.data ?? []).map((item: any) => item.price?.id));
  if (settings.detectDogFounderPriceId && prices.has(settings.detectDogFounderPriceId)) return "detect_dog_founder";
  if (settings.mosProPriceId && prices.has(settings.mosProPriceId)) return "pro";
  if (settings.elitePriceId && prices.has(settings.elitePriceId)) return "elite";
  if (settings.plusPriceId && prices.has(settings.plusPriceId)) return "plus";
  if (settings.starterPriceId && prices.has(settings.starterPriceId)) return "starter";
  return null;
}

/** An ordinary update to an established custom contract is not a new purchase.
 * Preserve its known package only for the same subscription and a non-trial,
 * non-incomplete account. Never promote trial setup flags into a paid contract.
 */
export function planForSubscriptionUpdate(subscription: any, settings: any, billing: any): string {
  const mapped = planForSubscription(subscription, settings);
  if (mapped) return mapped;
  const plan = billing?.plan;
  const established = ["active", "past_due", "suspended", "paused", "unpaid"].includes(billing?.status);
  const sameSubscription = !billing?.stripeSubscriptionId || billing.stripeSubscriptionId === subscription.id;
  if (established && sameSubscription && billing?.subscriptionAccessConfirmed !== false &&
      plan !== "trial" && Object.prototype.hasOwnProperty.call(PLAN_FALLBACK_KEYS, plan)) {
    return plan;
  }
  return "unrecognized";
}
