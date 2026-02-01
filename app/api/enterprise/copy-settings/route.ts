import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { getEnterpriseByShopId } from "@/lib/enterprise";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = String(session.shopId);
  const enterprise = await getEnterpriseByShopId(Number(session.shopId));

  if (!enterprise) {
    return NextResponse.json({ error: "Not part of an enterprise" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const sourceShopId = searchParams.get("sourceShopId");
  const settingType = searchParams.get("type");

  if (!sourceShopId) {
    return NextResponse.json({ error: "Source shop ID is required" }, { status: 400 });
  }

  if (!enterprise.shopIds.includes(Number(sourceShopId))) {
    return NextResponse.json({ error: "Source shop not in your enterprise" }, { status: 403 });
  }

  const sourceShopRows = await sql`
    SELECT * FROM shops WHERE shop_id = ${sourceShopId} LIMIT 1
  `;
  const sourceShop = sourceShopRows[0];

  if (!sourceShop) {
    return NextResponse.json({ error: "Source shop not found" }, { status: 404 });
  }

  const shopSettings = sourceShop.settings || {};
  const settings: Record<string, any> = {};

  if (!settingType || settingType === "branding") {
    settings.branding = {
      logo: shopSettings.branding?.logo || shopSettings.logo || null,
    };
  }

  if (!settingType || settingType === "maintenance") {
    settings.maintenance = {
      dueSoonMiles: shopSettings.maintenance?.dueSoonMiles || 1000,
      dueSoonDays: shopSettings.maintenance?.dueSoonDays || 30,
    };
  }

  if (!settingType || settingType === "intervals") {
    settings.intervals = shopSettings.maintenance?.intervals || {};
  }

  if (!settingType || settingType === "cannedJobs") {
    settings.cannedJobMappings = shopSettings.cannedJobMappings || shopSettings.protractor?.cannedJobMappings || {};
    settings.manualCannedJobs = shopSettings.manualCannedJobs || shopSettings.protractor?.manualCannedJobs || [];
    settings.hiddenCannedJobIds = shopSettings.hiddenCannedJobIds || shopSettings.protractor?.hiddenJobIds || [];
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

  const shopId = String(session.shopId);
  const enterprise = await getEnterpriseByShopId(Number(session.shopId));

  if (!enterprise) {
    return NextResponse.json({ error: "Not part of an enterprise" }, { status: 400 });
  }

  const body = await req.json();
  const { sourceShopId, settingTypes } = body;

  if (!sourceShopId) {
    return NextResponse.json({ error: "Source shop ID is required" }, { status: 400 });
  }

  if (!enterprise.shopIds.includes(Number(sourceShopId))) {
    return NextResponse.json({ error: "Source shop not in your enterprise" }, { status: 403 });
  }

  const sourceShopRows = await sql`
    SELECT * FROM shops WHERE shop_id = ${String(sourceShopId)} LIMIT 1
  `;
  const sourceShop = sourceShopRows[0];

  if (!sourceShop) {
    return NextResponse.json({ error: "Source shop not found" }, { status: 404 });
  }

  const shopSettings = sourceShop.settings || {};
  const types = settingTypes || ["branding", "maintenance", "intervals", "cannedJobs"];
  const updates: Record<string, any> = {};

  if (types.includes("branding")) {
    const logo = shopSettings.branding?.logo || shopSettings.logo || null;
    if (logo) {
      updates.branding = { ...updates.branding, logo };
    }
  }

  if (types.includes("maintenance")) {
    updates.maintenance = {
      ...updates.maintenance,
      dueSoonMiles: shopSettings.maintenance?.dueSoonMiles || 1000,
      dueSoonDays: shopSettings.maintenance?.dueSoonDays || 30,
    };
  }

  if (types.includes("intervals") && shopSettings.maintenance?.intervals) {
    updates.maintenance = {
      ...updates.maintenance,
      intervals: shopSettings.maintenance.intervals,
    };
  }

  if (types.includes("cannedJobs")) {
    const mappings = shopSettings.cannedJobMappings || shopSettings.protractor?.cannedJobMappings;
    const manualJobs = shopSettings.manualCannedJobs || shopSettings.protractor?.manualCannedJobs;
    const hiddenIds = shopSettings.hiddenCannedJobIds || shopSettings.protractor?.hiddenJobIds;
    
    if (mappings && Object.keys(mappings).length > 0) {
      updates.protractor = { ...updates.protractor, cannedJobMappings: mappings };
      updates.cannedJobMappings = mappings;
    }
    if (manualJobs && manualJobs.length > 0) {
      updates.protractor = { ...updates.protractor, manualCannedJobs: manualJobs };
      updates.manualCannedJobs = manualJobs;
    }
    if (hiddenIds && hiddenIds.length > 0) {
      updates.protractor = { ...updates.protractor, hiddenJobIds: hiddenIds };
      updates.hiddenCannedJobIds = hiddenIds;
    }
  }

  const currentShopRows = await sql`
    SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1
  `;
  const currentSettings = currentShopRows[0]?.settings || {};
  const mergedSettings = { ...currentSettings, ...updates };

  await sql`
    UPDATE shops SET 
      settings = ${JSON.stringify(mergedSettings)}::jsonb,
      updated_at = NOW()
    WHERE shop_id = ${shopId}
  `;

  return NextResponse.json({
    ok: true,
    message: `Copied settings from ${sourceShop.name || `Shop ${sourceShopId}`}`,
    copiedTypes: types,
  });
}
