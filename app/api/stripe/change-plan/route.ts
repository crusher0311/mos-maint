import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getStripe } from "@/lib/stripe";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { priceId, planId, isDowngrade } = await request.json();

    if (!priceId) {
      return NextResponse.json({ error: "Price ID is required" }, { status: 400 });
    }

    const db = await getDb();
    const shopId = Number(session.shopId);
    const shop = await db.collection("shops").findOne({ shopId });

    const stripeCustomerId = shop?.billing?.stripeCustomerId;
    const stripeSubscriptionId = shop?.billing?.stripeSubscriptionId;

    if (!stripeCustomerId || !stripeSubscriptionId) {
      return NextResponse.json({ error: "No active subscription found" }, { status: 400 });
    }

    const stripe = getStripe();

    const subscriptionData = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const subscription = subscriptionData as any;

    if (!subscription || subscription.status === "canceled") {
      return NextResponse.json({ error: "No active subscription found" }, { status: 400 });
    }

    const currentItemId = subscription.items?.data?.[0]?.id;
    if (!currentItemId) {
      return NextResponse.json({ error: "Subscription item not found" }, { status: 400 });
    }

    const periodEnd = subscription.current_period_end as number;

    if (isDowngrade) {
      await db.collection("shops").updateOne(
        { shopId },
        {
          $set: {
            "billing.pendingPlanChange": {
              priceId,
              planId,
              effectiveDate: new Date(periodEnd * 1000),
              currentSubscriptionId: stripeSubscriptionId,
            },
            "billing.updatedAt": new Date(),
            updatedAt: new Date(),
          },
        }
      );

      return NextResponse.json({
        success: true,
        message: `Your plan will change to ${planId} at the end of your billing cycle on ${new Date(periodEnd * 1000).toLocaleDateString()}.`,
        effectiveDate: new Date(periodEnd * 1000).toISOString(),
      });
    } else {
      await stripe.subscriptions.update(stripeSubscriptionId, {
        items: [
          {
            id: currentItemId,
            price: priceId,
          },
        ],
        proration_behavior: "create_prorations",
      });

      await db.collection("shops").updateOne(
        { shopId },
        {
          $set: {
            "billing.plan": planId,
            "billing.updatedAt": new Date(),
            plan: planId,
            updatedAt: new Date(),
          },
          $unset: {
            "billing.pendingPlanChange": "",
            pendingPlanChange: "",
          },
        }
      );

      return NextResponse.json({
        success: true,
        message: "Plan upgraded successfully! Prorated charges have been applied to your next invoice.",
      });
    }
  } catch (error: any) {
    console.error("Error changing plan:", error);
    return NextResponse.json({
      error: error.message || "Failed to change plan"
    }, { status: 500 });
  }
}
