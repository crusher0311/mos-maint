import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { stripe, getBillingSettings } from "@/lib/stripe";
import {
  sendEmail,
  makeTrialReminderEmail,
  makeTrialConvertedEmail,
  makeTrialSuspendedEmail,
} from "@/lib/email";
import { getPlatformAdminEmails } from "@/lib/super-admins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;
const REMINDER_DAYS = [7, 3, 1];

function isAuthorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return true;
  const authHeader = req.headers.get("authorization");
  const secretParam = req.nextUrl.searchParams.get("secret");
  return authHeader === `Bearer ${CRON_SECRET}` || secretParam === CRON_SECRET;
}

async function findOwnerEmail(db: any, shopId: number): Promise<string | null> {
  const owner = await db.collection("users").findOne(
    { shopId, role: { $in: ["owner", "admin"] } },
    { projection: { email: 1, emailLower: 1 } },
  );
  return owner?.email || owner?.emailLower || null;
}

function pickConversionPriceId(
  planSlug: string | undefined,
  settings: Awaited<ReturnType<typeof getBillingSettings>>,
): string | null {
  switch (planSlug) {
    case "starter":
      return settings.starterPriceId || null;
    case "plus":
    case "professional":
      return settings.plusPriceId || settings.starterPriceId || null;
    case "elite":
    case "enterprise":
      return settings.elitePriceId || settings.plusPriceId || settings.starterPriceId || null;
    default:
      return settings.starterPriceId || settings.plusPriceId || null;
  }
}

async function processOne(
  db: any,
  shop: any,
  baseUrl: string,
  settings: Awaited<ReturnType<typeof getBillingSettings>>,
  platformAdminEmails: string[],
) {
  const shopId: number = shop.shopId;
  const trialEndsAt: Date | null = shop.trial?.endsAt
    ? new Date(shop.trial.endsAt)
    : (shop.trialEndsAt ? new Date(shop.trialEndsAt) : null);
  if (!trialEndsAt) return { shopId, skipped: "no_trial" };
  // Defensive: never act on a shop that already has an active subscription
  // or whose billing has moved past trial state.
  const billingStatus: string | undefined = shop.billing?.status;
  if (billingStatus && !["trial", "trialing"].includes(billingStatus)) {
    return { shopId, skipped: `billing_status:${billingStatus}` };
  }
  if (shop.billing?.stripeSubscriptionId) {
    return { shopId, skipped: "already_subscribed" };
  }

  const now = new Date();
  const msLeft = trialEndsAt.getTime() - now.getTime();
  const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
  const cardOnFile = !!(shop.cardOnFile || shop.billing?.cardOnFile);
  const stripeCustomerId: string | undefined = shop.stripeCustomerId || shop.billing?.stripeCustomerId;
  const paymentMethodId: string | undefined = shop.stripePaymentMethodId || shop.billing?.stripePaymentMethodId;
  const ownerEmail = await findOwnerEmail(db, shopId);
  const addCardUrl = `${baseUrl}/dashboard/settings/billing`;

  if (msLeft > 0) {
    if (cardOnFile) {
      return { shopId, skipped: "card_on_file", daysLeft };
    }
    const reminderDay = REMINDER_DAYS.find((d) => daysLeft === d);
    if (reminderDay) {
      const sent = shop.trial?.reminderSent || {};
      if (!sent[String(reminderDay)] && ownerEmail) {
        try {
          const msg = makeTrialReminderEmail(shop.name, daysLeft, trialEndsAt, addCardUrl);
          await sendEmail({ to: ownerEmail, ...msg });
          await db.collection("shops").updateOne(
            { shopId },
            { $set: { [`trial.reminderSent.${reminderDay}`]: now } },
          );
          await db.collection("audit_logs").insertOne({
            type: "shop_trial_reminder_sent",
            shopId,
            shopName: shop.name,
            daysLeft: reminderDay,
            ownerEmail,
            createdAt: now,
          });
          return { shopId, action: "reminder_sent", reminderDay };
        } catch (err: any) {
          console.error(`[trial-check] reminder send failed for ${shopId}:`, err?.message);
          return { shopId, error: "reminder_failed" };
        }
      }
    }
    return { shopId, skipped: "active", daysLeft };
  }

  if (cardOnFile && stripeCustomerId) {
    try {
      const planSlug = shop.billing?.plan || "starter";
      const priceId = pickConversionPriceId(planSlug, settings);
      if (!priceId) {
        console.warn(`[trial-check] no priceId for ${shopId} plan=${planSlug}; falling back to suspend`);
      } else {
        const subscription = await stripe.subscriptions.create({
          customer: stripeCustomerId,
          items: [{ price: priceId }],
          ...(paymentMethodId ? { default_payment_method: paymentMethodId } : {}),
          metadata: {
            shopId: String(shopId),
            convertedFromTrial: "true",
            originalTrialEndedAt: trialEndsAt.toISOString(),
          },
        });

        await db.collection("shops").updateOne(
          { shopId },
          {
            $set: {
              "billing.plan": planSlug === "trial" ? "starter" : planSlug,
              "billing.status": "active",
              "billing.stripeSubscriptionId": subscription.id,
              "billing.stripeCustomerId": stripeCustomerId,
              "billing.updatedAt": now,
              trialConvertedAt: now,
              updatedAt: now,
            },
          },
        );
        await db.collection("audit_logs").insertOne({
          type: "shop_trial_converted",
          shopId,
          shopName: shop.name,
          planSlug,
          stripeSubscriptionId: subscription.id,
          createdAt: now,
        });
        if (ownerEmail) {
          try {
            const msg = makeTrialConvertedEmail(shop.name, planSlug, `${baseUrl}/dashboard`);
            await sendEmail({ to: ownerEmail, ...msg });
          } catch (err: any) {
            console.error(`[trial-check] converted email failed for ${shopId}:`, err?.message);
          }
        }
        return { shopId, action: "converted", planSlug, subscriptionId: subscription.id };
      }
    } catch (err: any) {
      console.error(`[trial-check] convert failed for ${shopId}:`, err?.message);
      // fall through to suspend
    }
  }

  await db.collection("shops").updateOne(
    { shopId },
    {
      $set: {
        isLocked: true,
        lockedAt: now,
        lockedBy: "system:trial-check",
        "billing.status": "suspended",
        trialSuspendedAt: now,
        updatedAt: now,
      },
    },
  );
  await db.collection("audit_logs").insertOne({
    type: "shop_trial_suspended",
    shopId,
    shopName: shop.name,
    reason: cardOnFile ? "conversion_failed" : "no_card_on_file",
    createdAt: now,
  });
  if (ownerEmail) {
    try {
      const msg = makeTrialSuspendedEmail(shop.name, addCardUrl, true);
      await sendEmail({ to: ownerEmail, ...msg });
    } catch (err: any) {
      console.error(`[trial-check] suspend email failed for ${shopId}:`, err?.message);
    }
  }
  if (platformAdminEmails.length > 0) {
    try {
      const adminMsg = makeTrialSuspendedEmail(shop.name, `${baseUrl}/platform-admin/shops`, false);
      await sendEmail({
        to: platformAdminEmails[0],
        ...(platformAdminEmails.length > 1 ? { cc: platformAdminEmails.slice(1).join(",") } : {}),
        ...adminMsg,
      });
    } catch (err: any) {
      console.error(`[trial-check] admin suspend email failed for ${shopId}:`, err?.message);
    }
  }
  return { shopId, action: "suspended", cardOnFile };
}

async function runChecks(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const db = await getDb();
  const settings = await getBillingSettings();
  const platformAdminEmails = await getPlatformAdminEmails();
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "https://mos.tools");

  const horizon = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  const candidates = await db
    .collection("shops")
    .find({
      $and: [
        { $or: [{ "trial.endsAt": { $exists: true, $ne: null } }, { trialEndsAt: { $exists: true, $ne: null } }] },
        { $or: [{ "trial.endsAt": { $lte: horizon } }, { trialEndsAt: { $lte: horizon } }] },
        { trialConvertedAt: { $exists: false } },
        { trialSuspendedAt: { $exists: false } },
        // Only consider shops still in a trial billing state — never reprocess paid/active shops.
        { $or: [
          { "billing.status": { $in: ["trial", "trialing"] } },
          { "billing.status": { $exists: false } },
        ] },
        { "billing.stripeSubscriptionId": { $in: [null, undefined, ""] } },
      ],
    })
    .toArray();

  const results: any[] = [];
  for (const shop of candidates) {
    try {
      const r = await processOne(db, shop, baseUrl, settings, platformAdminEmails);
      results.push(r);
    } catch (err: any) {
      console.error(`[trial-check] processOne failed for ${shop.shopId}:`, err?.message);
      results.push({ shopId: shop.shopId, error: err?.message || "unknown" });
    }
  }

  const summary = {
    ok: true,
    processed: candidates.length,
    reminders: results.filter((r) => r.action === "reminder_sent").length,
    converted: results.filter((r) => r.action === "converted").length,
    suspended: results.filter((r) => r.action === "suspended").length,
    skipped: results.filter((r) => r.skipped).length,
    errors: results.filter((r) => r.error).length,
    elapsedMs: Date.now() - startTime,
    results,
  };
  console.log(`[trial-check] processed=${summary.processed} reminders=${summary.reminders} converted=${summary.converted} suspended=${summary.suspended} errors=${summary.errors}`);
  return NextResponse.json(summary);
}

export async function GET(req: NextRequest) {
  return runChecks(req);
}

export async function POST(req: NextRequest) {
  return runChecks(req);
}
