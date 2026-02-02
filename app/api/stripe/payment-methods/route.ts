import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getStripe } from "@/lib/stripe";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ id: session.shopId });
    
    if (!shop?.stripeCustomerId) {
      return NextResponse.json({ paymentMethods: [] });
    }

    const stripe = getStripe();
    
    const [paymentMethods, customer] = await Promise.all([
      stripe.paymentMethods.list({
        customer: shop.stripeCustomerId,
        type: "card",
      }),
      stripe.customers.retrieve(shop.stripeCustomerId),
    ]);

    const defaultPaymentMethodId = typeof customer !== "string" && "invoice_settings" in customer
      ? customer.invoice_settings?.default_payment_method
      : null;

    return NextResponse.json({
      paymentMethods: paymentMethods.data.map(pm => ({
        id: pm.id,
        brand: pm.card?.brand,
        last4: pm.card?.last4,
        expMonth: pm.card?.exp_month,
        expYear: pm.card?.exp_year,
        isDefault: pm.id === defaultPaymentMethodId,
      }))
    });
  } catch (error) {
    console.error("Error fetching payment methods:", error);
    return NextResponse.json({ error: "Failed to fetch payment methods" }, { status: 500 });
  }
}
