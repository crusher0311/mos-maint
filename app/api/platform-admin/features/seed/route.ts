import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

const DEFAULT_FEATURES = [
  {
    order: 1,
    name: "Maintenance Recommendations",
    slug: "maintenance",
    description: "AI-powered maintenance recommendations from OEM data, service history, and DVI findings",
    category: "core",
    status: "active",
    icon: "Wrench",
    compatibleSMS: ["protractor", "tekmetric", "autoflow"],
    includedInTiers: ["starter", "plus", "elite", "enterprise"],
  },
  {
    order: 2,
    name: "Chrome Extension",
    slug: "chrome_extension",
    description: "Browser extension for quick access to MOS features from any tab",
    category: "addon",
    status: "active",
    icon: "Chrome",
    compatibleSMS: ["tekmetric"],
    includedInTiers: ["plus", "elite", "enterprise"],
  },
  {
    order: 3,
    name: "Job Lookup / History Writer",
    slug: "job_lookup",
    description: "Search historical jobs for parts, labor, and pricing. Add matching jobs to open work orders.",
    category: "addon",
    status: "active",
    icon: "Search",
    compatibleSMS: ["protractor", "tekmetric"],
    includedInTiers: ["plus", "elite", "enterprise"],
  },
  {
    order: 4,
    name: "CarFax Integration",
    slug: "carfax",
    description: "Access CarFax vehicle history reports directly in the platform",
    category: "addon",
    status: "active",
    icon: "FileText",
    compatibleSMS: ["tekmetric"],
    includedInTiers: ["plus", "elite", "enterprise"],
  },
  {
    order: 5,
    name: "Common Failures Advisor",
    slug: "common_failures",
    description: "Predict common repairs by vehicle, powertrain, and mileage using shop data and AI",
    category: "addon",
    status: "active",
    icon: "AlertTriangle",
    compatibleSMS: ["protractor", "tekmetric"],
    includedInTiers: ["elite", "enterprise"],
  },
  {
    order: 6,
    name: "OEM Data Integration",
    slug: "oem_data",
    description: "Access OEM service schedules and maintenance requirements",
    category: "addon",
    status: "active",
    icon: "Database",
    compatibleSMS: [],
    includedInTiers: ["plus", "elite", "enterprise"],
  },
  {
    order: 7,
    name: "Oil Sticker Platform",
    slug: "oil_sticker",
    description: "Generate and manage oil change reminder stickers with QR codes",
    category: "addon",
    status: "active",
    icon: "Droplet",
    compatibleSMS: [],
    includedInTiers: ["starter", "plus", "elite", "enterprise"],
  },
  {
    order: 8,
    name: "Auto Booking",
    slug: "auto_booking",
    description: "Automated appointment booking for oil change reminders",
    category: "addon",
    status: "active",
    icon: "Calendar",
    compatibleSMS: ["tekmetric"],
    includedInTiers: ["elite", "enterprise"],
  },
  {
    order: 9,
    name: "SMS Integration",
    slug: "sms_integration",
    description: "Send SMS reminders and notifications to customers",
    category: "addon",
    status: "active",
    icon: "MessageSquare",
    compatibleSMS: [],
    includedInTiers: ["elite", "enterprise"],
  },
  {
    order: 10,
    name: "Keytags",
    slug: "keytags",
    description: "Print customer and vehicle info on Dymo labels for key identification",
    category: "addon",
    status: "active",
    icon: "Tag",
    compatibleSMS: [],
    includedInTiers: ["plus", "elite", "enterprise"],
  },
  {
    order: 11,
    name: "Part Cross-Reference",
    slug: "part_xref",
    description: "Find interchangeable parts across manufacturers",
    category: "addon",
    status: "active",
    icon: "RefreshCw",
    compatibleSMS: ["protractor", "tekmetric"],
    includedInTiers: ["elite", "enterprise"],
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
