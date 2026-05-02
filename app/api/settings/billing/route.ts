import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getViewedVinCount } from "@/lib/plan-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TRIAL_VIN_LIMIT = 10;

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const shopId = Number(sess.shopId);

  const shop = await db.collection("shops").findOne({ shopId });
  const billing = shop?.billing || {};
  const isPaid = billing.plan === "professional" || billing.plan === "enterprise" || billing.plan === "appfueled_invoice";
  const isInvoicePlan = billing.plan === "appfueled_invoice";

  const rawPendingPlanChange = billing.pendingPlanChange ?? shop?.pendingPlanChange;
  const pendingPlanChange = rawPendingPlanChange?.planId && rawPendingPlanChange?.effectiveDate
    ? {
        planId: rawPendingPlanChange.planId,
        effectiveDate: rawPendingPlanChange.effectiveDate instanceof Date
          ? rawPendingPlanChange.effectiveDate.toISOString()
          : rawPendingPlanChange.effectiveDate,
      }
    : undefined;

  const periodEnd = billing.periodEnd ?? billing.nextBillingDate;
  const periodStart = billing.periodStart;

  const trialEndsAtRaw = shop?.trial?.endsAt ?? shop?.trialEndsAt ?? null;
  const trialStartedAtRaw = shop?.trial?.startedAt ?? shop?.trialStartedAt ?? null;
  const trialEndsAt = trialEndsAtRaw ? new Date(trialEndsAtRaw) : null;
  const trialStartedAt = trialStartedAtRaw ? new Date(trialStartedAtRaw) : null;
  const trialDays = shop?.trial?.days ?? shop?.trialDays ?? null;
  const trialDaysLeft = trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;
  const cardOnFile = !!(shop?.cardOnFile || billing?.cardOnFile);
  const trialBlock = trialEndsAt
    ? {
        startedAt: trialStartedAt ? trialStartedAt.toISOString() : null,
        endsAt: trialEndsAt.toISOString(),
        days: trialDays,
        daysLeft: trialDaysLeft,
        cardOnFile,
      }
    : null;

  if (isPaid) {
    const vehicleCount = await db.collection("vehicles").countDocuments({ 
      shopId: String(sess.shopId),
      "status.active": true,
    });

    const monthlyAmount = isInvoicePlan
      ? (typeof billing.invoiceMonthlyAmount === "number" ? billing.invoiceMonthlyAmount : null)
      : ((typeof shop?.stripeSubscriptionAmount === "number" ? shop.stripeSubscriptionAmount : null)
          ?? (typeof billing.stripeSubscriptionAmount === "number" ? billing.stripeSubscriptionAmount : null));

    const planLabel = isInvoicePlan ? "AppFueled Invoice" : (billing.plan || "Professional");

    return NextResponse.json({
      plan: planLabel,
      planSlug: billing.plan,
      status: billing.status || "active",
      vehicleCount,
      vehicleLimit: null,
      nextBillingDate: billing.nextBillingDate,
      periodStart,
      periodEnd,
      monthlyAmount,
      pendingPlanChange,
      cardOnFile,
      trial: trialBlock,
    });
  }

  const platformSettings = await db.collection("platform_settings").findOne({ key: "trial" });
  const defaultLimit = platformSettings?.vinLimit ?? DEFAULT_TRIAL_VIN_LIMIT;
  const shopLimit = shop?.trialVinLimit ?? defaultLimit;

  const viewedVinCount = await getViewedVinCount(db, shopId);

  return NextResponse.json({
    plan: trialBlock ? "Trial" : "Free Trial",
    planSlug: billing.plan,
    status: "trial",
    vehicleCount: viewedVinCount,
    vehicleLimit: shopLimit,
    nextBillingDate: trialEndsAt ? trialEndsAt.toISOString() : null,
    periodStart,
    periodEnd,
    pendingPlanChange,
    cardOnFile,
    trial: trialBlock,
  });
}
