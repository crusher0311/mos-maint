import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

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
    const [shops, recentPayments, enterprises, billingSettingsResult] = await Promise.all([
      sql`SELECT id, shop_id, name, location_identifier, enterprise_id, billing, created_at FROM shops`,
      sql`SELECT * FROM stripe_events WHERE type ~ '^invoice\\.|^checkout\\.session\\.completed' ORDER BY created_at DESC NULLS LAST LIMIT 20`,
      sql`SELECT id, name, shop_ids FROM enterprise_accounts`,
      sql`SELECT * FROM platform_settings WHERE type = 'billing' LIMIT 1`,
    ]);

    const enterpriseMap = new Map(enterprises.map(e => [e.id, e.name]));
    const billingSettings = billingSettingsResult[0]?.value as Record<string, unknown> | null;
    
    const configuredPricing: Record<string, number> = {
      starter: (billingSettings?.starterPrice as number) ?? 49,
      professional: (billingSettings?.mosProPrice as number) ?? 99,
      enterprise: (billingSettings?.enterprisePrice as number) ?? 199,
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
      const billing = shop.billing as Record<string, unknown> | null || {};
      const plan = (billing.plan as string) || "trial";
      const status = (billing.status as string) || "trial";
      
      if (planCounts[plan] !== undefined) {
        planCounts[plan]++;
      }
      
      if (statusCounts[status] !== undefined) {
        statusCounts[status]++;
      }
      
      const subscriptionAmount = billing.stripeSubscriptionAmount 
        ? (billing.stripeSubscriptionAmount as number) / 100 
        : configuredPricing[plan] || 0;
      
      if (billing.isPaid && (status === "active" || status === "past_due")) {
        totalMRR += subscriptionAmount;
        paidShopsCount++;
      }

      return {
        shopId: shop.shop_id ? parseInt(shop.shop_id, 10) : null,
        name: shop.name || `Shop ${shop.shop_id}`,
        locationIdentifier: shop.location_identifier,
        enterpriseName: shop.enterprise_id ? enterpriseMap.get(shop.enterprise_id) : null,
        plan,
        status,
        isPaid: billing.isPaid || false,
        vinViewCount: billing.vinViewCount || 0,
        vinLimit: billing.vinLimit || 10,
        stripeCustomerId: billing.stripeCustomerId,
        stripeSubscriptionId: billing.stripeSubscriptionId,
        createdAt: shop.created_at,
      };
    });

    shopBillingData.sort((a, b) => {
      const order = ["enterprise", "professional", "starter", "demo", "trial", "churned"];
      return order.indexOf(a.plan) - order.indexOf(b.plan);
    });

    const recentEvents = recentPayments.map(event => ({
      id: event.id,
      type: event.type,
      shopId: event.shop_id,
      shopName: event.shop_name,
      amount: event.amount,
      currency: event.currency,
      status: event.status,
      createdAt: event.created_at,
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Platform billing error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
