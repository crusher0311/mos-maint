import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const db = await getDb();
    
    const [shops, recentPayments, enterprises, billingSettings] = await Promise.all([
      db.collection("shops").find().project({
        shopId: 1,
        name: 1,
        locationIdentifier: 1,
        enterpriseId: 1,
        billing: 1,
        stripeCustomerId: 1,
        stripeSubscriptionId: 1,
        stripeSubscriptionAmount: 1,
        createdAt: 1,
      }).toArray(),
      db.collection("stripe_events").find({ type: { $regex: /^invoice\.|^checkout\.session\.completed/ } })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray(),
      db.collection("enterprise_accounts").find().project({ _id: 1, name: 1, shopIds: 1 }).toArray(),
      db.collection("platform_settings").findOne({ type: "billing" }),
    ]);

    const enterpriseMap = new Map(enterprises.map(e => [e._id.toString(), e.name]));
    
    const configuredPricing: Record<string, number> = {
      starter: billingSettings?.starterPrice ?? 49,
      professional: billingSettings?.mosProPrice ?? 99,
      enterprise: billingSettings?.enterprisePrice ?? 199,
    };

    const planCounts: Record<string, number> = {
      trial: 0,
      starter: 0,
      professional: 0,
      enterprise: 0,
      demo: 0,
      churned: 0,
    };

    const statusCounts: Record<string, number> = {
      trial: 0,
      active: 0,
      past_due: 0,
      canceled: 0,
      paused: 0,
    };

    let totalMRR = 0;
    let paidShopsCount = 0;

    const shopBillingData = shops.map(shop => {
      const billing = shop.billing || {};
      const plan = billing.plan || "trial";
      const status = billing.status || "trial";
      
      if (planCounts[plan] !== undefined) {
        planCounts[plan]++;
      }
      
      if (statusCounts[status] !== undefined) {
        statusCounts[status]++;
      }
      
      const subscriptionAmount = shop.stripeSubscriptionAmount 
        ? shop.stripeSubscriptionAmount / 100 
        : configuredPricing[plan] || 0;
      
      if (billing.isPaid && (status === "active" || status === "past_due")) {
        totalMRR += subscriptionAmount;
        paidShopsCount++;
      }

      return {
        shopId: shop.shopId,
        name: shop.name || `Shop ${shop.shopId}`,
        locationIdentifier: shop.locationIdentifier,
        enterpriseName: shop.enterpriseId ? enterpriseMap.get(shop.enterpriseId.toString()) : null,
        plan,
        status,
        isPaid: billing.isPaid || false,
        vinViewCount: billing.vinViewCount || 0,
        vinLimit: billing.vinLimit || 10,
        stripeCustomerId: shop.stripeCustomerId,
        stripeSubscriptionId: shop.stripeSubscriptionId,
        createdAt: shop.createdAt,
      };
    });

    shopBillingData.sort((a, b) => {
      const order = ["enterprise", "professional", "starter", "demo", "trial", "churned"];
      return order.indexOf(a.plan) - order.indexOf(b.plan);
    });

    const recentEvents = recentPayments.map(event => ({
      id: event._id.toString(),
      type: event.type,
      shopId: event.shopId,
      shopName: event.shopName,
      amount: event.amount,
      currency: event.currency,
      status: event.status,
      createdAt: event.createdAt,
    }));

    return NextResponse.json({
      ok: true,
      summary: {
        totalShops: shops.length,
        paidShops: paidShopsCount,
        totalMRR,
        planCounts,
        statusCounts,
      },
      shops: shopBillingData,
      recentEvents,
    });
  } catch (err: any) {
    console.error("Platform billing error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
