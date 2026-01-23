import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getStripe } from "@/lib/stripe";
import { ObjectId } from "mongodb";

async function requireEnterpriseAccess() {
  const session = await getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ id: session.shopId });

  if (!shop?.enterpriseId) {
    return { error: "Not part of an enterprise", status: 403 };
  }

  if (session.role !== "owner" && session.role !== "admin") {
    return { error: "Enterprise admin access required", status: 403 };
  }

  return { session, enterpriseId: shop.enterpriseId, db };
}

export async function POST(request: NextRequest) {
  const auth = await requireEnterpriseAccess();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { db, enterpriseId } = auth;

  try {
    const { shopId, planSlug } = await request.json();

    if (!shopId || !planSlug) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const enterpriseIdStr = enterpriseId.toString();
    let enterpriseObjId: ObjectId | null = null;
    try {
      enterpriseObjId = new ObjectId(enterpriseIdStr);
    } catch (e) {}

    const plans = await db.collection("billing_settings").findOne({ key: "plans" });
    const planConfig = plans?.plans?.find((p: any) => p.slug === planSlug);
    if (!planConfig) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }

    const priceId = planConfig.stripeMonthlyPriceId;
    if (!priceId) {
      return NextResponse.json({ error: "Plan not available for purchase" }, { status: 400 });
    }

    const targetShop = await db.collection("shops").findOne({
      id: shopId,
      $or: [
        ...(enterpriseObjId ? [{ enterpriseId: enterpriseObjId }] : []),
        { enterpriseId: enterpriseIdStr }
      ]
    });

    if (!targetShop) {
      return NextResponse.json({ error: "Shop not found in enterprise" }, { status: 404 });
    }

    const stripe = getStripe();

    const currentPlanSlug = targetShop.billing?.plan || targetShop.plan || "starter";
    const currentPlan = plans?.plans?.find((p: any) => p.slug === currentPlanSlug);
    const isDowngrade = planConfig.order < (currentPlan?.order || 0);

    if (!targetShop.stripeCustomerId || !targetShop.stripeSubscriptionId) {
      const checkoutSession = await stripe.checkout.sessions.create({
        customer_email: targetShop.email,
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: "subscription",
        success_url: `${process.env.NEXT_PUBLIC_BASE_URL || "https://mosmaintenance.com"}/dashboard/enterprise/billing?success=true&shopId=${shopId}`,
        cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL || "https://mosmaintenance.com"}/dashboard/enterprise/billing?canceled=true`,
        metadata: {
          shopId: shopId.toString(),
          planSlug,
          fromEnterprise: "true"
        }
      });

      return NextResponse.json({ checkoutUrl: checkoutSession.url });
    }

    const subscriptionData = await stripe.subscriptions.retrieve(targetShop.stripeSubscriptionId);
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
        { id: shopId },
        {
          $set: {
            pendingPlanChange: {
              priceId,
              planId: planSlug,
              effectiveDate: new Date(periodEnd * 1000),
              currentSubscriptionId: targetShop.stripeSubscriptionId,
            },
            updatedAt: new Date()
          }
        }
      );

      return NextResponse.json({
        success: true,
        message: `Plan will change to ${planConfig.name} at the end of billing cycle`,
        effectiveDate: new Date(periodEnd * 1000).toISOString(),
      });
    } else {
      await stripe.subscriptions.update(targetShop.stripeSubscriptionId, {
        items: [{ id: currentItemId, price: priceId }],
        proration_behavior: "create_prorations",
      });

      await db.collection("shops").updateOne(
        { id: shopId },
        {
          $set: {
            "billing.plan": planSlug,
            plan: planSlug,
            updatedAt: new Date()
          },
          $unset: { pendingPlanChange: "" }
        }
      );

      return NextResponse.json({
        success: true,
        message: `Upgraded to ${planConfig.name} successfully!`,
      });
    }
  } catch (error: any) {
    console.error("Error changing plan:", error);
    return NextResponse.json({ error: error.message || "Failed to change plan" }, { status: 500 });
  }
}
