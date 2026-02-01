import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import sql from "@/lib/db/postgres";

const DEFAULT_PLANS = [
  {
    name: "Starter",
    slug: "starter",
    order: 1,
    monthlyPrice: 199.95,
    description: "Maintenance + Oil Sticker",
    features: ["maintenance", "oil_sticker"],
    status: "active",
    isPopular: false,
    isEnterprise: false,
  },
  {
    name: "Plus",
    slug: "plus",
    order: 2,
    monthlyPrice: 229.95,
    description: "Maintenance + Job Lookup + Oil Sticker",
    features: ["maintenance", "job_lookup", "oil_sticker"],
    status: "active",
    isPopular: true,
    isEnterprise: false,
  },
  {
    name: "Elite Easy Button",
    slug: "elite",
    order: 3,
    monthlyPrice: 279.95,
    description: "All features included: Maintenance, Job Lookup, Oil Sticker, Keytags, Part Cross-Reference, Auto Booking",
    features: ["maintenance", "job_lookup", "oil_sticker", "keytags", "part_xref", "auto_booking", "common_failures", "chrome_extension"],
    status: "active",
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
    status: "active",
    isPopular: false,
    isEnterprise: true,
  },
];

export async function POST() {
  try {
    await requirePlatformAdmin();

    for (const plan of DEFAULT_PLANS) {
      await sql`
        INSERT INTO platform_plans (
          name, slug, plan_order, monthly_price, description, features, status, is_popular, is_enterprise,
          created_at, updated_at
        ) VALUES (
          ${plan.name}, ${plan.slug}, ${plan.order}, ${plan.monthlyPrice}, ${plan.description},
          ${JSON.stringify(plan.features)}::jsonb, ${plan.status}, ${plan.isPopular}, ${plan.isEnterprise},
          NOW(), NOW()
        )
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          plan_order = EXCLUDED.plan_order,
          monthly_price = EXCLUDED.monthly_price,
          description = EXCLUDED.description,
          features = EXCLUDED.features,
          status = EXCLUDED.status,
          is_popular = EXCLUDED.is_popular,
          is_enterprise = EXCLUDED.is_enterprise,
          updated_at = NOW()
      `;
    }

    return NextResponse.json({
      ok: true,
      message: `Seeded/updated ${DEFAULT_PLANS.length} plans`
    });
  } catch (error: any) {
    console.error("Error seeding plans:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to seed plans" }, { status: 500 });
  }
}
