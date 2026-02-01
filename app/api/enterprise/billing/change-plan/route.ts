import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getShopByShopId, getShopById } from "@/lib/db/shops-pg";
import sql from "@/lib/db/postgres";
import { getStripe } from "@/lib/stripe";

async function requireEnterpriseAccess() {
  const session = await getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }

  const shop = await getShopByShopId(session.shopId);

  if (!shop?.enterprise_id) {
    return { error: "Not part of an enterprise", status: 403 };
  }

  if (session.role !== "owner" && session.role !== "admin") {
    return { error: "Enterprise admin access required", status: 403 };
  }

  return { session, enterpriseId: shop.enterprise_id };
}

export async function POST(request: NextRequest) {
  const auth = await requireEnterpriseAccess();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { enterpriseId } = auth;

  try {
    const { shopId, planSlug } = await request.json();

    if (!shopId || !planSlug) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const plansResult = await sql<{plans: Array<{slug: string, name: string, order: number, stripeMonthlyPriceId: string}>}[]>`
      SELECT value as plans FROM settings WHERE key = 'plans' LIMIT 1
    `;
    const plans = plansResult[0]?.plans || [];
    const planConfig = plans.find((p) => p.slug === planSlug);
    if (!planConfig) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }

    const priceId = planConfig.stripeMonthlyPriceId;
    if (!priceId) {
      return NextResponse.json({ error: "Plan not available for purchase" }, { status: 400 });
    }

    const targetShop = typeof shopId === 'string' && shopId.includes('-') 
      ? await getShopById(shopId) 
      : await getShopByShopId(shopId);

    if (!targetShop || targetShop.enterprise_id !== enterpriseId) {
      return NextResponse.json({ error: "Shop not found in enterprise" }, { status: 404 });
    }

    const stripe = getStripe();
    const billing = targetShop.billing as Record<string, unknown> | null;
    const stripeCustomerId = billing?.stripeCustomerId as string | undefined;
    const stripeSubscriptionId = billing?.stripeSubscriptionId as string | undefined;

    const currentPlanSlug = (billing?.plan as string) || "starter";
    const currentPlan = plans.find((p) => p.slug === currentPlanSlug);
    const isDowngrade = planConfig.order < (currentPlan?.order || 0);

    if (!stripeCustomerId || !stripeSubscriptionId) {
      const checkoutSession = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        allow_promotion_codes: true,
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

    const subscriptionData = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const subscription = subscriptionData as unknown as {
      status: string;
      items?: { data?: Array<{ id: string }> };
      current_period_end: number;
    };
    
    if (!subscription || subscription.status === "canceled") {
      return NextResponse.json({ error: "No active subscription found" }, { status: 400 });
    }

    const currentItemId = subscription.items?.data?.[0]?.id;
    if (!currentItemId) {
      return NextResponse.json({ error: "Subscription item not found" }, { status: 400 });
    }

    const periodEnd = subscription.current_period_end;

    if (isDowngrade) {
      const existingSettings = (targetShop.settings as Record<string, unknown>) || {};
      const updatedSettings = {
        ...existingSettings,
        pendingPlanChange: {
          priceId,
          planId: planSlug,
          effectiveDate: new Date(periodEnd * 1000).toISOString(),
          currentSubscriptionId: stripeSubscriptionId,
        },
      };

      await sql`
        UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb, updated_at = NOW()
        WHERE id = ${shopId}
      `;

      return NextResponse.json({
        success: true,
        message: `Plan will change to ${planConfig.name} at the end of billing cycle`,
        effectiveDate: new Date(periodEnd * 1000).toISOString(),
      });
    } else {
      await stripe.subscriptions.update(stripeSubscriptionId, {
        items: [{ id: currentItemId, price: priceId }],
        proration_behavior: "create_prorations",
      });

      const updatedBilling = {
        ...(billing || {}),
        plan: planSlug,
      };

      await sql`
        UPDATE shops SET billing = ${JSON.stringify(updatedBilling)}::jsonb, updated_at = NOW()
        WHERE id = ${shopId}
      `;

      return NextResponse.json({
        success: true,
        message: `Upgraded to ${planConfig.name} successfully!`,
      });
    }
  } catch (error: unknown) {
    console.error("Error changing plan:", error);
    const message = error instanceof Error ? error.message : "Failed to change plan";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
