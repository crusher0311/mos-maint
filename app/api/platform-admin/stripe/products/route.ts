import { NextRequest, NextResponse } from "next/server";
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

export async function POST(request: NextRequest) {
  try {
    await requirePlatformAdmin();

    const body = await request.json();
    const { name, description, price, type, interval } = body;

    if (!name || !price) {
      return NextResponse.json({ error: "Name and price are required" }, { status: 400 });
    }

    const product = await stripe.products.create({
      name,
      description: description || undefined,
    });

    const priceData: Stripe.PriceCreateParams = {
      product: product.id,
      unit_amount: Math.round(price * 100),
      currency: "usd",
    };

    if (type === "recurring") {
      priceData.recurring = {
        interval: interval || "month",
      };
    }

    const stripePrice = await stripe.prices.create(priceData);

    return NextResponse.json({
      ok: true,
      product: {
        id: product.id,
        name: product.name,
        description: product.description,
        prices: [{
          id: stripePrice.id,
          unit_amount: stripePrice.unit_amount,
          currency: stripePrice.currency,
          recurring: stripePrice.recurring,
          type: stripePrice.type,
        }],
      },
    });
  } catch (error: any) {
    console.error("Error creating Stripe product:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message || "Failed to create product" }, { status: 500 });
  }
}
