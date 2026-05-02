// lib/shop-review.ts
// Central helpers for the shop review-state gate that controls whether
// transactional email may be sent to a shop. Every shop sits in one of
// three states: "pending" (default for new signups + backfilled shops),
// "approved" (greenlit by a platform admin — only state where email is
// allowed), or "flagged" (admin determined the shop shouldn't receive
// email). See task #252 for the rollout context.

import type { Db } from "mongodb";

export type ShopReviewStatus = "pending" | "approved" | "flagged";

export type ShopReviewFields = {
  reviewStatus: ShopReviewStatus;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
  autoFlagReasons: string[];
};

// Email kinds we gate. New transactional emails should be added here so
// suppression logs stay greppable.
export type GatedEmailKind =
  | "welcome"
  | "credentials_welcome"
  | "trial_reminder"
  | "trial_converted"
  | "trial_suspended"
  | "trial_conversion_payment_failed"
  | "trial_conversion_suspended"
  | "payment_failed"
  | "payment_recovered"
  | "grace_reminder"
  | "account_suspended"
  | "card_capture_resend"
  | "tekmetric_setup"
  | "ticket_created"
  | "ticket_updated"
  | "support_owner_copy"
  | "announcement";

export type AutoCheckShopInput = {
  billing?: {
    plan?: string | null;
    status?: string | null;
    cardOnFile?: boolean | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
  } | null;
  cardOnFile?: boolean | null;
  stripeCustomerId?: string | null;
  isLocked?: boolean | null;
  trial?: {
    endsAt?: Date | string | null;
  } | null;
  trialEndsAt?: Date | string | null;
};

/**
 * Compute the list of auto-flag reasons for a shop. An empty list means
 * the shop passes every automatic check and is a candidate for the
 * "approve" auto-suggestion; a non-empty list means the shop should be
 * flagged for closer manual review.
 */
export function computeAutoFlagReasons(shop: AutoCheckShopInput): string[] {
  const reasons: string[] = [];
  const billing = shop.billing || {};
  const status = (billing.status || "").toString().toLowerCase();
  const cardOnFile = Boolean(shop.cardOnFile ?? billing.cardOnFile);
  const stripeCustomerId = shop.stripeCustomerId ?? billing.stripeCustomerId ?? null;
  const stripeSubscriptionId = billing.stripeSubscriptionId ?? null;
  const trialEndsAtRaw = shop.trial?.endsAt ?? shop.trialEndsAt ?? null;
  const trialEndsAt = trialEndsAtRaw ? new Date(trialEndsAtRaw) : null;
  const trialExpired = !!(trialEndsAt && trialEndsAt.getTime() <= Date.now());

  const isTrialState =
    status === "trial" ||
    status === "trialing" ||
    (!status && !!trialEndsAt && !stripeSubscriptionId);

  if (isTrialState && !cardOnFile) {
    reasons.push("trial_no_card");
  }
  if (!stripeCustomerId) {
    reasons.push("no_stripe_customer");
  }
  if (status === "suspended") {
    reasons.push("billing_suspended");
  }
  if (status === "past_due") {
    reasons.push("billing_past_due");
  }
  if (status === "canceled") {
    reasons.push("billing_canceled");
  }
  if (shop.isLocked) {
    reasons.push("shop_locked");
  }
  if (trialExpired && !cardOnFile && !stripeSubscriptionId) {
    if (!reasons.includes("trial_no_card")) {
      reasons.push("trial_expired_no_card");
    } else {
      reasons.push("trial_expired_no_card");
    }
  }

  // De-dupe defensively in case of overlap.
  return Array.from(new Set(reasons));
}

/**
 * Returns the cleaned-up review fields for a shop. Treats missing fields
 * as "pending" so unmigrated docs are still gated until backfill runs.
 */
export function getReviewFields(shop: any | null | undefined): ShopReviewFields {
  const status = (shop?.reviewStatus as ShopReviewStatus | undefined) || "pending";
  const valid: ShopReviewStatus =
    status === "approved" || status === "flagged" ? status : "pending";
  return {
    reviewStatus: valid,
    reviewedAt: shop?.reviewedAt ? new Date(shop.reviewedAt) : null,
    reviewedBy: typeof shop?.reviewedBy === "string" ? shop.reviewedBy : null,
    reviewNotes: typeof shop?.reviewNotes === "string" ? shop.reviewNotes : null,
    autoFlagReasons: Array.isArray(shop?.autoFlagReasons)
      ? shop.autoFlagReasons.filter((r: unknown): r is string => typeof r === "string")
      : [],
  };
}

export function isApprovedForEmail(shop: any | null | undefined): boolean {
  return getReviewFields(shop).reviewStatus === "approved";
}

/**
 * Look up the current review state for a shop by id. Returns a sentinel
 * "shop_missing" status when the shop isn't found so callers can log it
 * without crashing.
 */
export async function getReviewStateForShopId(
  db: Db,
  shopId: number | string,
): Promise<{ found: boolean; fields: ShopReviewFields; shopName?: string }> {
  const variants: Array<number | string> = [shopId];
  if (typeof shopId === "string" && Number.isFinite(Number(shopId))) {
    variants.push(Number(shopId));
  } else if (typeof shopId === "number") {
    variants.push(String(shopId));
  }
  const shop = await db
    .collection("shops")
    .findOne(
      { shopId: { $in: variants } },
      { projection: { reviewStatus: 1, reviewedAt: 1, reviewedBy: 1, reviewNotes: 1, autoFlagReasons: 1, name: 1 } },
    );
  if (!shop) {
    return {
      found: false,
      fields: {
        reviewStatus: "pending",
        reviewedAt: null,
        reviewedBy: null,
        reviewNotes: null,
        autoFlagReasons: ["shop_not_found"],
      },
    };
  }
  return { found: true, fields: getReviewFields(shop), shopName: shop.name };
}

export const REVIEW_REASON_LABELS: Record<string, string> = {
  trial_no_card: "Trial with no card on file",
  no_stripe_customer: "No Stripe customer",
  billing_suspended: "Billing suspended",
  billing_past_due: "Billing past due",
  billing_canceled: "Billing canceled",
  shop_locked: "Shop locked",
  trial_expired_no_card: "Trial expired, no card",
  shop_not_found: "Shop not found",
};

export function describeAutoFlagReason(reason: string): string {
  return REVIEW_REASON_LABELS[reason] || reason;
}
