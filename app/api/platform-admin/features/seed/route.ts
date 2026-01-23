import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

const DEFAULT_FEATURES = [
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
    includedInTiers: ["starter", "plus", "elite", "enterprise"],
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
    includedInTiers: ["starter", "plus", "elite", "enterprise"],
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
    includedInTiers: ["starter", "plus", "elite", "enterprise"],
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
    includedInTiers: ["starter", "plus", "elite", "enterprise"],
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
    includedInTiers: ["plus", "elite", "enterprise"],
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
  // UTILITY FEATURES
  {
    order: 10,
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

    const db = await getDb();
    
    const existingCount = await db.collection("platform_features").countDocuments();
    if (existingCount > 0) {
      return NextResponse.json({ 
        ok: false, 
        error: "Features already exist. Delete all features first to reseed." 
      }, { status: 400 });
    }

    const now = new Date();
    const featuresWithTimestamps = DEFAULT_FEATURES.map(f => ({
      ...f,
      createdAt: now,
      updatedAt: now
    }));

    await db.collection("platform_features").insertMany(featuresWithTimestamps);

    return NextResponse.json({
      ok: true,
      message: `Seeded ${DEFAULT_FEATURES.length} features`
    });
  } catch (error: any) {
    console.error("Error seeding features:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to seed features" }, { status: 500 });
  }
}
