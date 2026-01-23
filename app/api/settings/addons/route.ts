import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getBillingSettings } from "@/lib/stripe";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const settings = await getBillingSettings();

    const vinPacks = [
      {
        size: 100,
        price: settings.vinPack100Price,
        priceId: settings.vinPack100PriceId,
        productId: settings.vinPack100ProductId,
      },
      {
        size: 250,
        price: settings.vinPack250Price,
        priceId: settings.vinPack250PriceId,
        productId: settings.vinPack250ProductId,
      },
      {
        size: 500,
        price: settings.vinPack500Price,
        priceId: settings.vinPack500PriceId,
        productId: settings.vinPack500ProductId,
      },
    ];

    return NextResponse.json({
      ok: true,
      vinPacks,
    });
  } catch (error) {
    console.error("Error fetching add-ons:", error);
    return NextResponse.json({ error: "Failed to fetch add-ons" }, { status: 500 });
  }
}
