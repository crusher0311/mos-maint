import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { stripe, getBaseUrl } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: Number(sess.shopId) });

  if (!shop?.stripeCustomerId) {
    return NextResponse.json(
      { error: "No billing account found. Please upgrade first." },
      { status: 400 }
    );
  }

  try {
    const baseUrl = getBaseUrl();
    
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: shop.stripeCustomerId,
      return_url: `${baseUrl}/dashboard/settings/billing`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (error: any) {
    console.error("Billing portal error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create billing portal session" },
      { status: 500 }
    );
  }
}
