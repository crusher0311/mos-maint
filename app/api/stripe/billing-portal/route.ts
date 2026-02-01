import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { stripe, getBaseUrl } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${String(sess.shopId)}`;
  const shop = shopRows[0] as any;

  if (!shop?.stripe_customer_id) {
    return NextResponse.json(
      { error: "No billing account found. Please upgrade first." },
      { status: 400 }
    );
  }

  try {
    const baseUrl = getBaseUrl();
    
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: shop.stripe_customer_id,
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
