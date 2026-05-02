import "server-only";
import type { Db } from "mongodb";
import {
  sendEmail,
  makeTrialReminderEmail,
  makeTrialSuspendedEmail,
} from "@/lib/email";
import { createCardSetupSession } from "@/lib/stripe";

export type CardCaptureMode = "reminder" | "suspended";

export interface CardCaptureResult {
  ok: boolean;
  shopId: number | string;
  shopName?: string;
  ownerEmail?: string;
  mode?: CardCaptureMode;
  stripeCheckoutSessionId?: string;
  stripeCustomerId?: string;
  error?: string;
}

/**
 * Send a single card-capture email for a shop, mirroring the platform-admin
 * "resend_card_capture" single-shop action. Used by both
 * `app/api/platform-admin/shops/[shopId]/route.ts` and the bulk endpoint so
 * the two paths stay in lock-step (same Stripe setup session, same email
 * templates, same audit-log shape).
 *
 * Returns a structured result instead of throwing so callers (especially the
 * bulk endpoint) can record per-shop success/failure without aborting the
 * whole batch.
 */
export async function resendCardCaptureForShop(opts: {
  db: Db;
  shopId: number | string;
  adminEmail: string;
}): Promise<CardCaptureResult> {
  const { db, shopId, adminEmail } = opts;

  const shop = await db.collection("shops").findOne({ shopId });
  if (!shop) {
    return { ok: false, shopId, error: "Shop not found" };
  }

  const numericShopId =
    typeof shopId === "number" ? shopId : Number(shopId);
  if (!Number.isFinite(numericShopId)) {
    return {
      ok: false,
      shopId,
      shopName: shop.name,
      error: "resend_card_capture requires a numeric shopId",
    };
  }

  const owner = await db.collection("users").findOne(
    { shopId, role: { $in: ["owner", "admin"] } },
    { projection: { email: 1, emailLower: 1 } },
  );
  const ownerEmail: string | undefined = owner?.email || owner?.emailLower;
  if (!ownerEmail) {
    return {
      ok: false,
      shopId,
      shopName: shop.name,
      error: "No owner/admin user found for this shop to email",
    };
  }

  let setupSession: Awaited<ReturnType<typeof createCardSetupSession>>;
  try {
    setupSession = await createCardSetupSession({
      shopId: numericShopId,
      ownerEmail,
      returnTo: "/dashboard/settings/billing",
      purpose: "trial_card_capture",
      createdVia: "platform_admin_resend_card_capture",
    });
  } catch (err: any) {
    console.error(
      `[Platform Admin] Failed to create Stripe setup session for shop ${shopId}:`,
      err?.message,
    );
    return {
      ok: false,
      shopId,
      shopName: shop.name,
      ownerEmail,
      error: err?.message || "Failed to create Stripe card setup session",
    };
  }

  const trialEndsAtRaw = shop.trial?.endsAt || shop.trialEndsAt || null;
  const trialEndsAt = trialEndsAtRaw ? new Date(trialEndsAtRaw) : null;
  const now = new Date();

  let msg;
  let mode: CardCaptureMode;
  if (trialEndsAt && trialEndsAt.getTime() > now.getTime()) {
    const daysLeft = Math.max(
      1,
      Math.ceil((trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    );
    msg = makeTrialReminderEmail(shop.name, daysLeft, trialEndsAt, setupSession.url);
    mode = "reminder";
  } else {
    msg = makeTrialSuspendedEmail(shop.name, setupSession.url, true);
    mode = "suspended";
  }

  try {
    await sendEmail({ to: ownerEmail, ...msg });
  } catch (err: any) {
    console.error(
      `[Platform Admin] Failed to send card-capture email for shop ${shopId}:`,
      err?.message,
    );
    return {
      ok: false,
      shopId,
      shopName: shop.name,
      ownerEmail,
      mode,
      stripeCheckoutSessionId: setupSession.sessionId,
      stripeCustomerId: setupSession.customerId,
      error: err?.message || "Failed to send email",
    };
  }

  await db.collection("audit_logs").insertOne({
    type: "shop_card_capture_email_resent",
    shopId,
    shopName: shop.name,
    ownerEmail,
    mode,
    stripeCheckoutSessionId: setupSession.sessionId,
    stripeCustomerId: setupSession.customerId,
    adminEmail,
    createdAt: now,
  });

  return {
    ok: true,
    shopId,
    shopName: shop.name,
    ownerEmail,
    mode,
    stripeCheckoutSessionId: setupSession.sessionId,
    stripeCustomerId: setupSession.customerId,
  };
}
