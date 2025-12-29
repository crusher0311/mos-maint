import { NextResponse } from "next/server";
import { stripe, STRIPE_PRODUCTS } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const prices = await stripe.prices.list({
      product: STRIPE_PRODUCTS.professional,
      active: true,
      expand: ["data.product"],
    });

    const formattedPrices = prices.data.map((price) => ({
      id: price.id,
      unitAmount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring?.interval,
      intervalCount: price.recurring?.interval_count,
      productName: typeof price.product === "object" ? (price.product as any).name : null,
    }));

    return NextResponse.json({ prices: formattedPrices });
  } catch (error: any) {
    console.error("Error fetching prices:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch prices" },
      { status: 500 }
    );
  }
}
