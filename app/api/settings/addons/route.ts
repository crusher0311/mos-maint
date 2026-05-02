import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

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

    const db = await getDb();

    const platformFeatures = await db.collection("platform_features")
      .find({ status: "active", category: { $in: ["core", "addon"] } })
      .sort({ order: 1 })
      .toArray();

    const featureAddons: FeatureAddon[] = platformFeatures.map(f => ({
      slug: f.slug,
      name: f.name,
      description: f.description,
      icon: f.icon || "Package",
      monthlyPrice: f.pricePerMonth || f.monthlyPrice || 0,
      stripePriceId: f.stripePriceId,
      stripeProductId: f.stripeProductId,
      category: f.category,
      requiresFeature: f.requiresFeature,
    }));

    return NextResponse.json({
      ok: true,
      featureAddons,
    });
  } catch (error) {
    console.error("Error fetching add-ons:", error);
    return NextResponse.json({ error: "Failed to fetch add-ons" }, { status: 500 });
  }
}
