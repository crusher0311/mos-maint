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
  if (!sess.shopId) {
    return NextResponse.json({ error: "Shop session required" }, { status: 400 });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: Number(sess.shopId) });
  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }

  const baseUrl = getBaseUrl();

  let returnTo = "/dashboard";
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.returnTo === "string" && body.returnTo.startsWith("/")) {
      returnTo = body.returnTo;
    }
  } catch {
    // ignore
  }

  try {
    let customerId: string | undefined = shop.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: sess.email,
        name: shop.name,
        metadata: {
          shopId: String(sess.shopId),
          shopName: shop.name || "",
          createdVia: "setup_card_endpoint",
        },
      });
      customerId = customer.id;

      await db.collection("shops").updateOne(
        { shopId: Number(sess.shopId) },
        { $set: { stripeCustomerId: customerId, "billing.stripeCustomerId": customerId } }
      );
    }

    const sep = returnTo.includes("?") ? "&" : "?";

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "setup",
      payment_method_types: ["card"],
      success_url: `${baseUrl}${returnTo}${sep}card_setup=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}${returnTo}${sep}card_setup=canceled`,
      metadata: {
        shopId: String(sess.shopId),
        purpose: "trial_card_capture",
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (error: any) {
    console.error("Stripe setup-card error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create card setup session" },
      { status: 500 }
    );
  }
}
