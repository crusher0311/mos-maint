import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function GET() {
  try {
    await requirePlatformAdmin();

    const products = await stripe.products.list({
      active: true,
      limit: 100,
    });

    const productsWithPrices = await Promise.all(
      products.data.map(async (product) => {
        const prices = await stripe.prices.list({
          product: product.id,
          active: true,
          limit: 10,
        });

        return {
          id: product.id,
          name: product.name,
          description: product.description,
          metadata: product.metadata,
          prices: prices.data.map((price) => ({
            id: price.id,
            unit_amount: price.unit_amount,
            currency: price.currency,
            recurring: price.recurring,
            type: price.type,
          })),
        };
      })
    );

    return NextResponse.json({
      ok: true,
      products: productsWithPrices,
    });
  } catch (error: any) {
    console.error("Error fetching Stripe products:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to fetch products" }, { status: 500 });
  }
}
