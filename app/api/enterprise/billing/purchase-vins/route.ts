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
    const { shopId, packSize } = await request.json();

    if (!shopId || !packSize) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const billingSettings = await sql<{packs: Array<{size: number, priceId: string}>}[]>`
      SELECT value as packs FROM settings WHERE key = 'vinPacks' LIMIT 1
    `;
    const vinPack = billingSettings[0]?.packs?.find((p) => p.size === packSize);
    if (!vinPack || !vinPack.priceId) {
      return NextResponse.json({ error: "Invalid VIN pack" }, { status: 400 });
    }

    const priceId = vinPack.priceId;

    const targetShop = typeof shopId === 'string' && shopId.includes('-') 
      ? await getShopById(shopId) 
      : await getShopByShopId(shopId);

    if (!targetShop || targetShop.enterprise_id !== enterpriseId) {
      return NextResponse.json({ error: "Shop not found in enterprise" }, { status: 404 });
    }

    const stripe = getStripe();
    const billing = targetShop.billing as Record<string, unknown> | null;
    const stripeCustomerId = billing?.stripeCustomerId as string | undefined;

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: stripeCustomerId || undefined,
      payment_method_types: ["card"],
      allow_promotion_codes: true,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "payment",
      success_url: `${process.env.NEXT_PUBLIC_BASE_URL || "https://mosmaintenance.com"}/dashboard/enterprise/billing?success=true&shopId=${shopId}&vins=${packSize}`,
      cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL || "https://mosmaintenance.com"}/dashboard/enterprise/billing?canceled=true`,
      metadata: {
        shopId: shopId.toString(),
        vinPackSize: packSize.toString(),
        type: "vin_pack",
        fromEnterprise: "true"
      }
    });

    return NextResponse.json({ checkoutUrl: checkoutSession.url });
  } catch (error: unknown) {
    console.error("Error purchasing VINs:", error);
    const message = error instanceof Error ? error.message : "Failed to purchase VINs";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
