// app/api/admin/billing/sync-stripe/route.ts
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { stripe } from "@/lib/stripe";

export async function GET() {
  try {
    const session = await requireSession();
    
    if (session.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const prices = await stripe.prices.list({
      active: true,
      limit: 100,
      expand: ["data.product"],
    });

    const formattedPrices = prices.data.map((price) => ({
      id: price.id,
      product: typeof price.product === "string" ? price.product : price.product.id,
      productName: typeof price.product === "object" && "name" in price.product ? price.product.name : "",
      unitAmount: price.unit_amount || 0,
      currency: price.currency,
      interval: price.recurring?.interval || null,
    }));

    return NextResponse.json({ prices: formattedPrices });
  } catch (error: any) {
    console.error("Error syncing from Stripe:", error);
    return NextResponse.json(
      { error: error.message || "Failed to sync from Stripe" },
      { status: 500 }
    );
  }
}
