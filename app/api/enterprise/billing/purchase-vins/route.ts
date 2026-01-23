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
    const { shopId, packSize } = await request.json();

    if (!shopId || !packSize) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const billingSettings = await db.collection("billing_settings").findOne({ key: "vinPacks" });
    const vinPack = billingSettings?.packs?.find((p: any) => p.size === packSize);
    if (!vinPack || !vinPack.priceId) {
      return NextResponse.json({ error: "Invalid VIN pack" }, { status: 400 });
    }

    const priceId = vinPack.priceId;

    const enterpriseIdStr = enterpriseId.toString();
    let enterpriseObjId: ObjectId | null = null;
    try {
      enterpriseObjId = new ObjectId(enterpriseIdStr);
    } catch (e) {}

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

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: targetShop.stripeCustomerId || undefined,
      customer_email: targetShop.stripeCustomerId ? undefined : targetShop.email,
      payment_method_types: ["card"],
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
  } catch (error: any) {
    console.error("Error purchasing VINs:", error);
    return NextResponse.json({ error: error.message || "Failed to purchase VINs" }, { status: 500 });
  }
}
