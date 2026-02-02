import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

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

    const db = await getDb();
    
    for (const plan of DEFAULT_PLANS) {
      await db.collection("platform_plans").updateOne(
        { slug: plan.slug },
        { 
          $set: {
            ...plan,
            updatedAt: new Date()
          },
          $setOnInsert: {
            createdAt: new Date()
          }
        },
        { upsert: true }
      );
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
