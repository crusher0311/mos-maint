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
    const { shopId } = await request.json();

    if (!shopId) {
      return NextResponse.json({ error: "Shop ID required" }, { status: 400 });
    }

    const targetShop = typeof shopId === 'string' && shopId.includes('-') 
      ? await getShopById(shopId) 
      : await getShopByShopId(shopId);

    if (!targetShop || targetShop.enterprise_id !== enterpriseId) {
      return NextResponse.json({ error: "Shop not found in enterprise" }, { status: 404 });
    }

    const billing = targetShop.billing as Record<string, unknown> | null;
    const stripeCustomerId = billing?.stripeCustomerId as string | undefined;

    if (!stripeCustomerId) {
      return NextResponse.json({ error: "No billing account for this location" }, { status: 400 });
    }

    const stripe = getStripe();

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${process.env.NEXT_PUBLIC_BASE_URL || "https://mosmaintenance.com"}/dashboard/enterprise/billing`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (error: unknown) {
    console.error("Error creating portal session:", error);
    const message = error instanceof Error ? error.message : "Failed to open billing portal";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
