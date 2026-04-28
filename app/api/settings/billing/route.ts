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
  const isPaid = billing.plan === "professional" || billing.plan === "enterprise";

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

  if (isPaid) {
    const vehicleCount = await db.collection("vehicles").countDocuments({ 
      shopId: String(sess.shopId),
      "status.active": true,
    });

    const monthlyAmount =
      (typeof shop?.stripeSubscriptionAmount === "number" ? shop.stripeSubscriptionAmount : null)
      ?? (typeof billing.stripeSubscriptionAmount === "number" ? billing.stripeSubscriptionAmount : null);

    return NextResponse.json({
      plan: billing.plan || "Professional",
      planSlug: billing.plan,
      status: billing.status || "active",
      vehicleCount,
      vehicleLimit: null,
      nextBillingDate: billing.nextBillingDate,
      periodStart,
      periodEnd,
      monthlyAmount,
      pendingPlanChange,
    });
  }

  const platformSettings = await db.collection("platform_settings").findOne({ key: "trial" });
  const defaultLimit = platformSettings?.vinLimit ?? DEFAULT_TRIAL_VIN_LIMIT;
  const shopLimit = shop?.trialVinLimit ?? defaultLimit;

  const viewedVinCount = await getViewedVinCount(db, shopId);

  return NextResponse.json({
    plan: "Free Trial",
    planSlug: billing.plan,
    status: "trial",
    vehicleCount: viewedVinCount,
    vehicleLimit: shopLimit,
    nextBillingDate: null,
    periodStart,
    periodEnd,
    pendingPlanChange,
  });
}
