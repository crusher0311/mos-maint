import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getViewedVinCount } from "@/lib/plan-cache";
import {
  isInvoiceBilled,
  resolveEffectiveBillingStatus,
  resolvePaymentType,
} from "@/lib/billing-helpers";
import {
  findShopByShopId,
  type ShopDoc,
} from "@/lib/data/repositories/shops";

type BillingRecord = Record<string, unknown> & {
  plan?: string;
  paymentType?: string;
  status?: string;
  pendingPlanChange?: { planId?: string; effectiveDate?: Date | string };
  periodEnd?: Date | string;
  periodStart?: Date | string;
  nextBillingDate?: Date | string;
  cardOnFile?: boolean;
  invoiceMonthlyAmount?: number;
  stripeSubscriptionAmount?: number;
};

type BillingShopDoc = ShopDoc & {
  billing?: BillingRecord;
  pendingPlanChange?: BillingRecord["pendingPlanChange"];
  trial?: { endsAt?: Date | string; startedAt?: Date | string; days?: number };
  trialEndsAt?: Date | string;
  trialStartedAt?: Date | string;
  trialDays?: number;
  cardOnFile?: boolean;
  stripeSubscriptionAmount?: number;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const shopId = Number(sess.shopId);

  // getSession() is the authority for the currently viewed shop, including
  // Ghost Mode. The repository keeps that lookup consistent in PG-canonical
  // and mixed numeric/string Mongo environments.
  const shop = await findShopByShopId<BillingShopDoc>(shopId);
  const billing: BillingRecord = shop?.billing || {};
  const isInvoicePlan = isInvoiceBilled(billing);
  const effectiveStatus = resolveEffectiveBillingStatus(billing, "trial");
  const isPaid = billing.plan === "professional" || billing.plan === "enterprise" || isInvoicePlan;

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
      paymentType: resolvePaymentType(billing),
      status: effectiveStatus,
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

  const viewedVinCount = await getViewedVinCount(db, shopId);

  return NextResponse.json({
    plan: trialBlock ? "Trial" : "Free Trial",
    planSlug: billing.plan,
    paymentType: resolvePaymentType(billing),
    status: effectiveStatus,
    vehicleCount: viewedVinCount,
    vehicleLimit: null,
    nextBillingDate: trialEndsAt ? trialEndsAt.toISOString() : null,
    periodStart,
    periodEnd,
    pendingPlanChange,
    cardOnFile,
    trial: trialBlock,
  });
}
