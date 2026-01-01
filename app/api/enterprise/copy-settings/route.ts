import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getEnterpriseByShopId } from "@/lib/enterprise";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const enterprise = await getEnterpriseByShopId(shopId);

  if (!enterprise) {
    return NextResponse.json({ error: "Not part of an enterprise" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const sourceShopId = Number(searchParams.get("sourceShopId"));
  const settingType = searchParams.get("type");

  if (!sourceShopId) {
    return NextResponse.json({ error: "Source shop ID is required" }, { status: 400 });
  }

  if (!enterprise.shopIds.includes(sourceShopId)) {
    return NextResponse.json({ error: "Source shop not in your enterprise" }, { status: 403 });
  }

  const db = await getDb();
  const sourceShop = await db.collection("shops").findOne({ shopId: sourceShopId });

  if (!sourceShop) {
    return NextResponse.json({ error: "Source shop not found" }, { status: 404 });
  }

  const settings: Record<string, any> = {};

  if (!settingType || settingType === "branding") {
    settings.branding = {
      logo: sourceShop.branding?.logo || sourceShop.logo || null,
    };
  }

  if (!settingType || settingType === "maintenance") {
    settings.maintenance = {
      dueSoonMiles: sourceShop.maintenance?.dueSoonMiles || 1000,
      dueSoonDays: sourceShop.maintenance?.dueSoonDays || 30,
    };
  }

  if (!settingType || settingType === "intervals") {
    settings.intervals = sourceShop.maintenance?.intervals || {};
  }

  if (!settingType || settingType === "cannedJobs") {
    // Check both root-level and protractor-nested locations for mappings
    settings.cannedJobMappings = sourceShop.cannedJobMappings || sourceShop.protractor?.cannedJobMappings || {};
    settings.manualCannedJobs = sourceShop.manualCannedJobs || sourceShop.protractor?.manualCannedJobs || [];
    settings.hiddenCannedJobIds = sourceShop.hiddenCannedJobIds || sourceShop.protractor?.hiddenJobIds || [];
  }

  return NextResponse.json({
    ok: true,
    sourceShopId,
    sourceShopName: sourceShop.name || `Shop ${sourceShopId}`,
    settings,
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!["owner", "admin", "manager"].includes(session.role || "")) {
    return NextResponse.json({ error: "Permission denied" }, { status: 403 });
  }

  const shopId = Number(session.shopId);
  const enterprise = await getEnterpriseByShopId(shopId);

  if (!enterprise) {
    return NextResponse.json({ error: "Not part of an enterprise" }, { status: 400 });
  }

  const body = await req.json();
  const { sourceShopId, settingTypes } = body;

  if (!sourceShopId) {
    return NextResponse.json({ error: "Source shop ID is required" }, { status: 400 });
  }

  if (!enterprise.shopIds.includes(sourceShopId)) {
    return NextResponse.json({ error: "Source shop not in your enterprise" }, { status: 403 });
  }

  const db = await getDb();
  const sourceShop = await db.collection("shops").findOne({ shopId: sourceShopId });

  if (!sourceShop) {
    return NextResponse.json({ error: "Source shop not found" }, { status: 404 });
  }

  const types = settingTypes || ["branding", "maintenance", "intervals", "cannedJobs"];
  const updates: Record<string, any> = { updatedAt: new Date() };

  if (types.includes("branding")) {
    const logo = sourceShop.branding?.logo || sourceShop.logo || null;
    if (logo) {
      updates["branding.logo"] = logo;
    }
  }

  if (types.includes("maintenance")) {
    updates["maintenance.dueSoonMiles"] = sourceShop.maintenance?.dueSoonMiles || 1000;
    updates["maintenance.dueSoonDays"] = sourceShop.maintenance?.dueSoonDays || 30;
  }

  if (types.includes("intervals") && sourceShop.maintenance?.intervals) {
    updates["maintenance.intervals"] = sourceShop.maintenance.intervals;
  }

  if (types.includes("cannedJobs")) {
    // Copy from either root-level or protractor-nested locations
    const mappings = sourceShop.cannedJobMappings || sourceShop.protractor?.cannedJobMappings;
    const manualJobs = sourceShop.manualCannedJobs || sourceShop.protractor?.manualCannedJobs;
    const hiddenIds = sourceShop.hiddenCannedJobIds || sourceShop.protractor?.hiddenJobIds;
    
    // Copy to both locations to ensure compatibility
    if (mappings && Object.keys(mappings).length > 0) {
      updates["protractor.cannedJobMappings"] = mappings;
      updates.cannedJobMappings = mappings;
    }
    if (manualJobs && manualJobs.length > 0) {
      updates["protractor.manualCannedJobs"] = manualJobs;
      updates.manualCannedJobs = manualJobs;
    }
    if (hiddenIds && hiddenIds.length > 0) {
      updates["protractor.hiddenJobIds"] = hiddenIds;
      updates.hiddenCannedJobIds = hiddenIds;
    }
  }

  await db.collection("shops").updateOne(
    { shopId },
    { $set: updates }
  );

  return NextResponse.json({
    ok: true,
    message: `Copied settings from ${sourceShop.name || `Shop ${sourceShopId}`}`,
    copiedTypes: types,
  });
}
