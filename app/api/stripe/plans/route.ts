import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getBillingSettings } from "@/lib/stripe";

export interface PlatformPlan {
  _id: string;
  name: string;
  slug: string;
  description: string;
  order: number;
  monthlyPrice: number;
  yearlyPrice?: number;
  stripeMonthlyPriceId?: string;
  stripeYearlyPriceId?: string;
  features: string[];
  status: "active" | "inactive";
  isPopular?: boolean;
  isEnterprise?: boolean;
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const billingSettings = await getBillingSettings();

    const plans = await db.collection("platform_plans")
      .find({ status: "active" })
      .sort({ order: 1 })
      .toArray();

    const features = await db.collection("platform_features")
      .find({ status: "active" })
      .sort({ order: 1 })
      .toArray();

    if (plans.length === 0) {
      const defaultPlans = [
        {
          name: "Starter",
          slug: "starter",
          order: 1,
          monthlyPrice: billingSettings.starterPrice || 199.95,
          stripeMonthlyPriceId: billingSettings.starterPriceId || undefined,
          description: "Maintenance + Oil Sticker",
          features: features.filter(f => f.includedInTiers?.includes("starter")).map(f => f.slug),
          isPopular: false,
          isEnterprise: false,
        },
        {
          name: "Plus",
          slug: "plus",
          order: 2,
          monthlyPrice: billingSettings.plusPrice || 229.95,
          stripeMonthlyPriceId: billingSettings.plusPriceId || billingSettings.mosProPriceId || undefined,
          description: "Maintenance + Job Lookup + Oil Sticker",
          features: features.filter(f => f.includedInTiers?.includes("plus")).map(f => f.slug),
          isPopular: true,
          isEnterprise: false,
        },
        {
          name: "Elite Easy Button",
          slug: "elite",
          order: 3,
          monthlyPrice: billingSettings.elitePrice || 279.95,
          stripeMonthlyPriceId: billingSettings.elitePriceId || undefined,
          description: "All features included: Maintenance, Job Lookup, Oil Sticker, Keytags, Part Cross-Reference, Auto Booking",
          features: features.filter(f => f.includedInTiers?.includes("elite")).map(f => f.slug),
          isPopular: false,
          isEnterprise: false,
        },
        {
          name: "Detect Dog - Founder",
          slug: "detect_dog_founder",
          order: 4,
          monthlyPrice: billingSettings.detectDogFounderPrice || 229.95,
          stripeMonthlyPriceId: billingSettings.detectDogFounderPriceId || undefined,
          description: "Founding-shop pricing for the full Detect Dog suite",
          features: features.filter(f => f.includedInTiers?.includes("detect_dog_founder")).map(f => f.slug),
          isPopular: false,
          isEnterprise: false,
        },
        {
          name: "Enterprise",
          slug: "enterprise",
          order: 5,
          monthlyPrice: 0,
          description: "Custom solutions for multi-location operations",
          features: [],
          isPopular: false,
          isEnterprise: true,
        },
      ];

      return NextResponse.json({ 
        plans: defaultPlans,
        features: features.map(f => ({
          _id: f._id,
          name: f.name,
          slug: f.slug,
          description: f.description,
          includedInTiers: f.includedInTiers || [],
        }))
      });
    }

    return NextResponse.json({ 
      plans,
      features: features.map(f => ({
        _id: f._id,
        name: f.name,
        slug: f.slug,
        description: f.description,
        includedInTiers: f.includedInTiers || [],
      }))
    });
  } catch (error) {
    console.error("Error fetching plans:", error);
    return NextResponse.json({ error: "Failed to fetch plans" }, { status: 500 });
  }
}
