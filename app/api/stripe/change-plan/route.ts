import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
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

    const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${String(session.shopId)}`;
    const shop = shopRows[0] as any;
    
    if (!shop?.stripe_customer_id || !shop?.stripe_subscription_id) {
      return NextResponse.json({ error: "No active subscription found" }, { status: 400 });
    }

    const stripe = getStripe();

    const subscriptionData = await stripe.subscriptions.retrieve(shop.stripe_subscription_id);
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
      await sql`
        UPDATE shops SET 
          pending_plan_change = ${JSON.stringify({
            priceId,
            planId,
            effectiveDate: new Date(periodEnd * 1000),
            currentSubscriptionId: shop.stripe_subscription_id,
          })}::jsonb,
          updated_at = NOW()
        WHERE shop_id = ${String(session.shopId)}
      `;

      return NextResponse.json({
        success: true,
        message: `Your plan will change to ${planId} at the end of your billing cycle on ${new Date(periodEnd * 1000).toLocaleDateString()}.`,
        effectiveDate: new Date(periodEnd * 1000).toISOString(),
      });
    } else {
      await stripe.subscriptions.update(shop.stripe_subscription_id, {
        items: [
          {
            id: currentItemId,
            price: priceId,
          },
        ],
        proration_behavior: "create_prorations",
      });

      await sql`
        UPDATE shops SET 
          plan = ${planId},
          pending_plan_change = NULL,
          updated_at = NOW()
        WHERE shop_id = ${String(session.shopId)}
      `;

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
