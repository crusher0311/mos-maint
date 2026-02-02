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
    const { shopId } = await request.json();

    if (!shopId) {
      return NextResponse.json({ error: "Shop ID required" }, { status: 400 });
    }

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

    if (!targetShop.stripeCustomerId) {
      return NextResponse.json({ error: "No billing account for this location" }, { status: 400 });
    }

    const stripe = getStripe();

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: targetShop.stripeCustomerId,
      return_url: `${process.env.NEXT_PUBLIC_BASE_URL || "https://mosmaintenance.com"}/dashboard/enterprise/billing`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (error: any) {
    console.error("Error creating portal session:", error);
    return NextResponse.json({ error: error.message || "Failed to open billing portal" }, { status: 500 });
  }
}
