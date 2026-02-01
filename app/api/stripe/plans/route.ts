import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
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

    const billingSettings = await getBillingSettings();

    const plans = await sql`
      SELECT * FROM platform_plans WHERE status = 'active' ORDER BY plan_order
    `;

    const features = await sql`
      SELECT * FROM platform_features WHERE status = 'active' ORDER BY feature_order
    `;

    if (plans.length === 0) {
      const defaultPlans = [
        {
          name: "Starter",
          slug: "starter",
          order: 1,
          monthlyPrice: billingSettings.starterPrice || 199.95,
          stripeMonthlyPriceId: billingSettings.starterPriceId || undefined,
          description: "Maintenance + Oil Sticker",
          features: features.filter((f: any) => f.included_in_tiers?.includes("starter")).map((f: any) => f.slug),
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
          features: features.filter((f: any) => f.included_in_tiers?.includes("plus")).map((f: any) => f.slug),
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
          features: features.filter((f: any) => f.included_in_tiers?.includes("elite")).map((f: any) => f.slug),
          isPopular: false,
          isEnterprise: false,
        },
        {
          name: "Enterprise",
          slug: "enterprise",
          order: 4,
          monthlyPrice: 0,
          description: "Custom solutions for multi-location operations",
          features: [],
          isPopular: false,
          isEnterprise: true,
        },
      ];

      return NextResponse.json({ 
        plans: defaultPlans,
        features: features.map((f: any) => ({
          _id: f.id,
          name: f.name,
          slug: f.slug,
          description: f.description,
          includedInTiers: f.included_in_tiers || [],
        }))
      });
    }

    return NextResponse.json({ 
      plans: plans.map((p: any) => ({
        _id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        order: p.plan_order,
        monthlyPrice: p.monthly_price,
        yearlyPrice: p.yearly_price,
        stripeMonthlyPriceId: p.stripe_monthly_price_id,
        stripeYearlyPriceId: p.stripe_yearly_price_id,
        features: p.features || [],
        status: p.status,
        isPopular: p.is_popular,
        isEnterprise: p.is_enterprise,
      })),
      features: features.map((f: any) => ({
        _id: f.id,
        name: f.name,
        slug: f.slug,
        description: f.description,
        includedInTiers: f.included_in_tiers || [],
      }))
    });
  } catch (error) {
    console.error("Error fetching plans:", error);
    return NextResponse.json({ error: "Failed to fetch plans" }, { status: 500 });
  }
}
