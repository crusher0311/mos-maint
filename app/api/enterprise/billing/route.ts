import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getShopByShopId } from "@/lib/db/shops-pg";
import { getEnterpriseById } from "@/lib/enterprise-pg";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireEnterpriseAccess() {
  const session = await getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }
  if (!["owner", "admin"].includes(session.role || "")) {
    return { error: "Forbidden - admin access required", status: 403 };
  }
  
  const shop = await getShopByShopId(session.shopId);
  
  if (!shop?.enterprise_id) {
    return { error: "Not part of an enterprise", status: 403 };
  }
  
  return { session, enterpriseId: shop.enterprise_id };
}

export async function GET() {
  const auth = await requireEnterpriseAccess();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { enterpriseId } = auth;

  try {
    const enterprise = await getEnterpriseById(enterpriseId);
    
    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    const shops = enterprise.shop_ids.length > 0 ? await sql`
      SELECT * FROM shops WHERE shop_id::int = ANY(${enterprise.shop_ids})
    ` : [];

    const locationBilling = await Promise.all(shops.map(async (shop) => {
      const billing = (shop.billing as Record<string, unknown>) || {};
      const isPaid = ["professional", "enterprise", "starter", "plus", "elite"].includes(billing.plan as string || "");
      
      let vehicleCount = 0;
      if (isPaid) {
        const countResult = await sql<{count: string}[]>`
          SELECT COUNT(*) as count FROM vehicles 
          WHERE shop_id = ${shop.id}
        `;
        vehicleCount = parseInt(countResult[0]?.count || "0", 10);
      } else {
        const countResult = await sql<{count: string}[]>`
          SELECT COUNT(DISTINCT vin) as count FROM plan_cache 
          WHERE shop_id = ${shop.id}
        `;
        vehicleCount = parseInt(countResult[0]?.count || "0", 10);
      }
      
      const settings = shop.settings as Record<string, unknown> | null;

      return {
        shopId: shop.shop_id ? parseInt(shop.shop_id, 10) : null,
        name: shop.name,
        locationIdentifier: shop.location_identifier || null,
        plan: billing.plan || "trial",
        planDisplay: billing.plan ? (String(billing.plan).charAt(0).toUpperCase() + String(billing.plan).slice(1)) : "Free Trial",
        status: billing.status || "trial",
        vehicleCount,
        vinLimit: billing.vinLimit || null,
        nextBillingDate: billing.nextBillingDate || null,
        stripeCustomerId: billing.stripeCustomerId || null,
        stripeSubscriptionId: billing.stripeSubscriptionId || null,
        enabledFeatures: (shop.settings as Record<string, unknown>)?.enabledFeatures || [],
      };
    }));

    const totalVehicles = locationBilling.reduce((sum, loc) => sum + loc.vehicleCount, 0);
    const activeLocations = locationBilling.filter(loc => loc.status === "active" || loc.status === "trial").length;
    
    const enterpriseBillingResult = await sql<{billing: Record<string, unknown> | null}[]>`
      SELECT billing FROM enterprise_accounts WHERE id = ${enterpriseId} LIMIT 1
    `;
    const enterpriseBilling = enterpriseBillingResult[0]?.billing || {};
    
    const hasEnterpriseBilling = enterpriseBilling.enabled === true;
    const enterprisePlan = enterpriseBilling.plan || null;
    const enterpriseStatus = enterpriseBilling.status || null;

    return NextResponse.json({
      enterprise: {
        id: enterprise.id,
        name: enterprise.name,
        hasEnterpriseBilling,
        plan: enterprisePlan,
        status: enterpriseStatus,
        stripeCustomerId: enterpriseBilling.stripeCustomerId || null,
        nextBillingDate: enterpriseBilling.nextBillingDate || null,
      },
      summary: {
        totalLocations: shops.length,
        activeLocations,
        totalVehicles,
      },
      locations: locationBilling,
    });
  } catch (err: unknown) {
    console.error("Error fetching enterprise billing:", err);
    return NextResponse.json({ error: "Failed to fetch billing data" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireEnterpriseAccess();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { enterpriseId } = auth;

  try {
    const body = await req.json();
    const { action } = body;

    if (action === "enable_enterprise_billing") {
      await sql`
        UPDATE enterprise_accounts 
        SET billing = COALESCE(billing, '{}'::jsonb) || '{"enabled": true}'::jsonb,
            updated_at = NOW()
        WHERE id = ${enterpriseId}
      `;
      return NextResponse.json({ ok: true, message: "Enterprise billing enabled" });
    }

    if (action === "disable_enterprise_billing") {
      await sql`
        UPDATE enterprise_accounts 
        SET billing = COALESCE(billing, '{}'::jsonb) || '{"enabled": false}'::jsonb,
            updated_at = NOW()
        WHERE id = ${enterpriseId}
      `;
      return NextResponse.json({ ok: true, message: "Enterprise billing disabled" });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: unknown) {
    console.error("Error updating enterprise billing:", err);
    return NextResponse.json({ error: "Failed to update billing" }, { status: 500 });
  }
}
