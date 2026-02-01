import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getBillingSettings } from "@/lib/stripe";
import sql from "@/lib/db/postgres";

export interface FeatureAddon {
  slug: string;
  name: string;
  description: string;
  icon: string;
  monthlyPrice: number;
  stripePriceId?: string;
  stripeProductId?: string;
  category: string;
  requiresFeature?: string;
}

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

    const platformFeatures = await sql`
      SELECT * FROM platform_features 
      WHERE status = 'active' AND category IN ('core', 'addon')
      ORDER BY "order" ASC
    `;

    const featureAddons: FeatureAddon[] = platformFeatures.map(f => ({
      slug: f.slug,
      name: f.name,
      description: f.description,
      icon: f.icon || "Package",
      monthlyPrice: f.price_per_month || f.monthly_price || 0,
      stripePriceId: f.stripe_price_id,
      stripeProductId: f.stripe_product_id,
      category: f.category,
      requiresFeature: f.requires_feature,
    }));

    return NextResponse.json({
      ok: true,
      vinPacks,
      featureAddons,
    });
  } catch (error) {
    console.error("Error fetching add-ons:", error);
    return NextResponse.json({ error: "Failed to fetch add-ons" }, { status: 500 });
  }
}
