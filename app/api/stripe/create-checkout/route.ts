import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { stripe, STRIPE_PRODUCTS, getBaseUrl } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { priceId, plan } = await req.json();
  
  if (!priceId || !plan) {
    return NextResponse.json({ error: "Missing priceId or plan" }, { status: 400 });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: Number(sess.shopId) });
  
  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }

  const baseUrl = getBaseUrl();
  
  try {
    let customerId = shop.stripeCustomerId;
    
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: sess.email,
        name: shop.name,
        metadata: {
          shopId: String(sess.shopId),
          shopName: shop.name || "",
        },
      });
      customerId = customer.id;
      
      await db.collection("shops").updateOne(
        { shopId: Number(sess.shopId) },
        { $set: { stripeCustomerId: customerId } }
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/dashboard/settings/billing?success=true`,
      cancel_url: `${baseUrl}/dashboard/settings/billing?canceled=true`,
      metadata: {
        shopId: String(sess.shopId),
        plan,
      },
      subscription_data: {
        metadata: {
          shopId: String(sess.shopId),
          plan,
        },
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (error: any) {
    console.error("Stripe checkout error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
