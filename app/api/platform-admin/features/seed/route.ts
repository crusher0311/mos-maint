import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  insertMissingPlatformFeatures,
} from "@/lib/data/repositories/platform-features";
import { getDb as getPgDb } from "@/lib/db/drizzle";
import { platformFeatures } from "@/lib/db/schema/platform-features";

const DEFAULT_FEATURES = [
  {
    order: -1,
    name: "Sales Coach",
    slug: "sales_coach",
    description: "Review open estimates and generate customer-ready sales scripts.",
    category: "core",
    status: "active",
    icon: "Megaphone",
    compatibleSMS: ["protractor", "tekmetric", "autoflow", "shopware", "shopmonkey"],
    includedInTiers: [],
  },
  // Task #991 — Auto DVI ships dark: no tiers include it until an admin
  // enables it per shop or adds a tier here. Seeding the row (rather than
  // leaving it unseeded) makes the OFF state explicit and admin-editable.
  {
    order: 0,
    name: "Auto DVI",
    slug: "auto_dvi",
    description: "Auto-build a vehicle-specific inspection from VHI maintenance data plus the shop's custom inspection items, and write it to the open work order.",
    category: "core",
    status: "active",
    icon: "ClipboardCheck",
    compatibleSMS: ["protractor", "tekmetric"],
    includedInTiers: [],
  },
  // CORE FEATURES - Can be purchased individually or as add-ons to other core features
  {
    order: 1,
    name: "Maintenance Recommendations",
    slug: "maintenance",
    description: "AI-powered maintenance recommendations from OEM data, service history, and DVI findings. Includes OEM Data and CarFax integration.",
    category: "core",
    status: "active",
    icon: "Wrench",
    compatibleSMS: ["stand-alone", "protractor", "tekmetric", "autoflow", "shopware", "shopmonkey"],
    includedInTiers: ["starter", "plus", "elite", "enterprise"],
    bundledFeatures: ["oem_data", "carfax"],
  },
  {
    order: 2,
    name: "Job Lookup / History Writer",
    slug: "job_lookup",
    description: "Search historical jobs for parts, labor, and pricing. Add matching jobs to open work orders.",
    category: "core",
    status: "active",
    icon: "Search",
    compatibleSMS: ["stand-alone", "protractor", "tekmetric", "autoflow", "shopware", "shopmonkey"],
    includedInTiers: ["plus", "elite", "enterprise"],
  },
  {
    order: 3,
    name: "Common Failures Advisor",
    slug: "common_failures",
    description: "Predict common repairs by vehicle, powertrain, and mileage using shop data and AI",
    category: "core",
    status: "active",
    icon: "AlertTriangle",
    compatibleSMS: ["stand-alone", "protractor", "tekmetric", "autoflow", "shopware", "shopmonkey"],
    includedInTiers: ["elite", "enterprise"],
  },
  {
    order: 4,
    name: "Oil Sticker Platform",
    slug: "oil_sticker",
    description: "Generate and manage oil change reminder stickers with QR codes",
    category: "core",
    status: "active",
    icon: "Droplet",
    compatibleSMS: ["stand-alone", "protractor", "tekmetric", "autoflow", "shopware", "shopmonkey"],
    includedInTiers: ["starter", "plus", "elite", "enterprise"],
  },
  {
    order: 5,
    name: "Keytags",
    slug: "keytags",
    description: "Print customer and vehicle info on Dymo labels for key identification",
    category: "core",
    status: "active",
    icon: "Tag",
    compatibleSMS: ["stand-alone", "protractor", "tekmetric", "autoflow", "shopware", "shopmonkey"],
    includedInTiers: ["elite", "enterprise"],
  },
  {
    order: 6,
    name: "Part Cross-Reference",
    slug: "part_xref",
    description: "Find interchangeable parts across manufacturers",
    category: "core",
    status: "active",
    icon: "RefreshCw",
    compatibleSMS: ["stand-alone", "protractor", "tekmetric", "autoflow", "shopware", "shopmonkey"],
    includedInTiers: ["elite", "enterprise"],
  },
  // ADD-ON ONLY - Requires Oil Sticker to be active
  {
    order: 7,
    name: "Auto Booking",
    slug: "auto_booking",
    description: "Automated appointment booking for oil change reminders. Requires Oil Sticker Platform.",
    category: "addon",
    status: "active",
    icon: "Calendar",
    compatibleSMS: ["tekmetric"],
    includedInTiers: ["elite", "enterprise"],
    requiresFeature: "oil_sticker",
  },
  // BUNDLED FEATURES - Enabled with Maintenance, not sold separately
  {
    order: 8,
    name: "OEM Data Integration",
    slug: "oem_data",
    description: "Access OEM service schedules and maintenance requirements. Bundled with Maintenance.",
    category: "bundled",
    status: "active",
    icon: "Database",
    compatibleSMS: ["stand-alone", "protractor", "tekmetric", "autoflow", "shopware", "shopmonkey"],
    includedInTiers: [],
    bundledWith: "maintenance",
  },
  {
    order: 9,
    name: "CarFax Integration",
    slug: "carfax",
    description: "Access CarFax vehicle history reports. Bundled with Maintenance.",
    category: "bundled",
    status: "active",
    icon: "FileText",
    compatibleSMS: ["stand-alone", "protractor", "tekmetric", "autoflow", "shopware", "shopmonkey"],
    includedInTiers: [],
    bundledWith: "maintenance",
  },
  {
    order: 10,
    name: "Labor Rate Rules",
    slug: "labor_rate_rules",
    description: "Automatically apply labor rate adjustments based on vehicle make, fuel type, job type, and customer type. Rules are applied in real-time via the Chrome Extension.",
    category: "addon",
    status: "active",
    icon: "DollarSign",
    compatibleSMS: ["tekmetric"],
    includedInTiers: ["plus", "elite", "enterprise"],
    requiresFeature: "chrome_extension",
  },
  {
    order: 11,
    name: "Concern Assistant",
    slug: "concern_assistant",
    description: "AI-powered customer concern intake with follow-up questions, conversation review, and direct injection into repair order concern fields.",
    category: "addon",
    status: "active",
    icon: "MessageSquare",
    compatibleSMS: ["tekmetric", "protractor"],
    includedInTiers: ["plus", "elite", "enterprise"],
    requiresFeature: "chrome_extension",
  },
  // UTILITY FEATURES
  {
    order: 12,
    name: "Chrome Extension",
    slug: "chrome_extension",
    description: "Browser extension for quick access to MOS features from any tab",
    category: "addon",
    status: "active",
    icon: "Chrome",
    compatibleSMS: ["tekmetric"],
    includedInTiers: ["plus", "elite", "enterprise"],
  },
];

export async function POST() {
  try {
    await requirePlatformAdmin();

    const now = new Date();
    const featuresWithTimestamps = DEFAULT_FEATURES.map(f => ({
      ...f,
      createdAt: now,
      updatedAt: now,
    }));

    const inserted = await insertMissingPlatformFeatures(featuresWithTimestamps);
    const pg = getPgDb();
    await pg
      .insert(platformFeatures)
      .values(
        featuresWithTimestamps.map((feature) => ({
          order: feature.order,
          name: feature.name,
          slug: feature.slug,
          description: feature.description,
          status: feature.status,
          includedInTiers: feature.includedInTiers,
          createdAt: feature.createdAt,
          updatedAt: feature.updatedAt,
        })),
      )
      .onConflictDoNothing({ target: platformFeatures.slug });

    return NextResponse.json({
      ok: true,
      message: `Added ${inserted} missing feature${inserted === 1 ? "" : "s"}`,
      inserted,
    });
  } catch (error: any) {
    console.error("Error seeding features:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to seed features" }, { status: 500 });
  }
}
