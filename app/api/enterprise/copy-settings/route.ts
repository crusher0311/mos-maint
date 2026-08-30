import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import {
  findShopByShopId,
  listShopLaborRateRulesByIds,
  replaceLaborRateRulesForShopIds,
} from "@/lib/data/repositories/shops";
import {
  LaborRateRuleValidationError,
  canManageEnterpriseLaborRates,
  normalizeLaborRateRuleSet,
  validateEnterpriseLaborRateScope,
} from "@/lib/labor-rate-rules";

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

  if (
    settingType === "laborRates" &&
    !canManageEnterpriseLaborRates(session)
  ) {
    return NextResponse.json({ error: "Permission denied" }, { status: 403 });
  }

  if (!sourceShopId) {
    return NextResponse.json({ error: "Source shop ID is required" }, { status: 400 });
  }

  if (!enterprise.shopIds.map(Number).includes(sourceShopId)) {
    return NextResponse.json({ error: "Source shop not in your enterprise" }, { status: 403 });
  }

  const sourceShop = await findShopByShopId<any>(sourceShopId);

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

  if (settingType === "laborRates") {
    try {
      settings.laborRates = normalizeLaborRateRuleSet(sourceShop.laborRateRules ?? []);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid labor-rate rules" },
        { status: 409 },
      );
    }
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

  if (
    !["owner", "admin", "manager", "platform_admin"].includes(session.role || "") &&
    !session.isPlatformAdmin
  ) {
    return NextResponse.json({ error: "Permission denied" }, { status: 403 });
  }

  const shopId = Number(session.shopId);
  const enterprise = await getEnterpriseByShopId(shopId);

  if (!enterprise) {
    return NextResponse.json({ error: "Not part of an enterprise" }, { status: 400 });
  }

  const body = await req.json();
  const sourceShopId = Number(body.sourceShopId);
  const { settingTypes } = body;

  if (!sourceShopId) {
    return NextResponse.json({ error: "Source shop ID is required" }, { status: 400 });
  }

  if (!enterprise.shopIds.map(Number).includes(sourceShopId)) {
    return NextResponse.json({ error: "Source shop not in your enterprise" }, { status: 403 });
  }

  const types = settingTypes || ["branding", "maintenance", "intervals", "cannedJobs"];
  const includesLaborRates = types.includes("laborRates");
  if (
    includesLaborRates &&
    !canManageEnterpriseLaborRates(session)
  ) {
    return NextResponse.json({ error: "Permission denied" }, { status: 403 });
  }
  if (includesLaborRates && types.length !== 1) {
    return NextResponse.json(
      { error: "laborRates must be copied separately from other setting types" },
      { status: 400 },
    );
  }

  const copyToAllOther =
    body.applyToAllLocations === true ||
    body.copyToAll === true ||
    body.destination === "allOther" ||
    body.destinationShopId === "all";
  if (copyToAllOther && sourceShopId !== shopId) {
    return NextResponse.json(
      { error: "Bulk copy source must be your current session shop" },
      { status: 403 },
    );
  }
  if (copyToAllOther && !includesLaborRates) {
    return NextResponse.json(
      { error: "Bulk copy is only supported for laborRates" },
      { status: 400 },
    );
  }
  try {
    validateEnterpriseLaborRateScope({
      currentShopId: shopId,
      enterpriseShopIds: enterprise.shopIds,
      sourceShopId,
      destinationShopIds: copyToAllOther
        ? enterprise.shopIds.map(Number).filter((id: number) => id !== shopId)
        : [shopId],
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid enterprise shop scope" },
      { status: 403 },
    );
  }

  const sourceShop = await findShopByShopId<any>(sourceShopId);

  if (!sourceShop) {
    return NextResponse.json({ error: "Source shop not found" }, { status: 404 });
  }

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

  let laborRateRules;
  try {
    if (includesLaborRates) {
      // `?? []` is intentional: a missing/empty source set clears destinations.
      laborRateRules = normalizeLaborRateRuleSet(sourceShop.laborRateRules ?? []);
    }
  } catch (error) {
    if (error instanceof LaborRateRuleValidationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  if (copyToAllOther) {
    const destinationShopIds = enterprise.shopIds
      .map(Number)
      .filter((id: number) => Number.isFinite(id) && id !== shopId);
    const destinationShops = await listShopLaborRateRulesByIds(destinationShopIds);
    if (destinationShops.length !== destinationShopIds.length) {
      return NextResponse.json(
        {
          error: "Cannot copy: one or more enterprise destination locations were not found",
          expectedCount: destinationShopIds.length,
          matchedCount: destinationShops.length,
          updatedCount: 0,
        },
        { status: 409 },
      );
    }
    const result = await replaceLaborRateRulesForShopIds(
      destinationShopIds,
      laborRateRules!,
    );
    const matchedCount = result.matchedCount ?? 0;
    const updatedCount = result.modifiedCount ?? 0;
    if (matchedCount !== destinationShopIds.length) {
      return NextResponse.json(
        {
          error: "Not every enterprise destination location was updated",
          expectedCount: destinationShopIds.length,
          matchedCount,
          updatedCount,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      message: `Copied labor rates to ${destinationShopIds.length} other locations`,
      copiedTypes: ["laborRates"],
      destinationShopIds,
      matchedCount,
      updatedCount,
    });
  }

  if (includesLaborRates && types.length === 1) {
    const result = await replaceLaborRateRulesForShopIds(
      [shopId],
      laborRateRules!,
    );
    if ((result.matchedCount ?? 0) !== 1) {
      return NextResponse.json(
        { error: "Destination shop was not found", matchedCount: 0, updatedCount: 0 },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      message: `Copied labor rates from ${sourceShop.name || `Shop ${sourceShopId}`}`,
      copiedTypes: ["laborRates"],
      matchedCount: result.matchedCount,
      updatedCount: result.modifiedCount ?? 0,
    });
  } else {
    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      { $set: updates }
    );
  }

  return NextResponse.json({
    ok: true,
    message: `Copied settings from ${sourceShop.name || `Shop ${sourceShopId}`}`,
    copiedTypes: types,
  });
}
