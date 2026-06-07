import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import { isOverrideUnit } from "@/lib/shop-distance-unit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_WORKFLOW_STAGES = ["InspectionInProgress", "Unassigned", "WorkAuthorized", "EstimateCompleted"];

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const shopId = Number(sess.shopId);
  const shop = await db.collection("shops").findOne({ shopId });
  
  // Get enterprise info for job history location selection
  let enterpriseShops: { shopId: number; name: string }[] = [];
  const enterprise = await getEnterpriseByShopId(shopId);
  if (enterprise && enterprise.shopIds.length > 1) {
    const siblingShops = await db.collection("shops")
      .find({ shopId: { $in: enterprise.shopIds } })
      .project({ shopId: 1, name: 1, locationIdentifier: 1 })
      .toArray();
    enterpriseShops = siblingShops.map((s: any) => ({ 
      shopId: s.shopId, 
      name: s.name,
      locationIdentifier: s.locationIdentifier || null
    }));
  }

  return NextResponse.json({
    distanceUnit: shop?.preferences?.distanceUnit || "miles",
    timezone: shop?.preferences?.timezone || "America/New_York",
    workflowStages: shop?.preferences?.workflowStages || DEFAULT_WORKFLOW_STAGES,
    showInspectItems: shop?.preferences?.showInspectItems !== false,
    showOnlyWithMileage: shop?.preferences?.showOnlyWithMileage !== false,
    showRecalls: shop?.preferences?.showRecalls !== false,
    recallsExpanded: shop?.preferences?.recallsExpanded !== false,
    tekmetricLabels: shop?.preferences?.tekmetricLabels || [],
    jobHistoryShopIds: shop?.preferences?.jobHistoryShopIds || null,
    shopwareAddMode: shop?.preferences?.shopwareAddMode || "finding-published",
    floatingDetectDogEnabled:
      typeof shop?.preferences?.floatingDetectDogEnabled === "boolean"
        ? shop.preferences.floatingDetectDogEnabled
        : null,
    enterpriseShops,
  });
}

const VALID_WORKFLOW_STAGES = [
  "ScheduledWork",
  "InspectionInProgress",
  "Unassigned",
  "WorkCompleted",
  "WorkAuthorized",
  "EstimateCompleted",
];

export async function PUT(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { distanceUnit, timezone, workflowStages, showInspectItems, showOnlyWithMileage, showRecalls, recallsExpanded, tekmetricLabels, jobHistoryShopIds, shopwareAddMode, floatingDetectDogEnabled } = await req.json();

  if (distanceUnit && !["miles", "kilometers"].includes(distanceUnit)) {
    return NextResponse.json({ error: "Invalid distance unit" }, { status: 400 });
  }

  if (
    floatingDetectDogEnabled !== undefined &&
    floatingDetectDogEnabled !== null &&
    typeof floatingDetectDogEnabled !== "boolean"
  ) {
    return NextResponse.json({ error: "Invalid floatingDetectDogEnabled value" }, { status: 400 });
  }

  const db = await getDb();

  if (workflowStages && (!Array.isArray(workflowStages) || !workflowStages.every(s => VALID_WORKFLOW_STAGES.includes(s)))) {
    return NextResponse.json({ error: "Invalid workflow stages" }, { status: 400 });
  }

  const updates: Record<string, any> = {};

  // Distance unit: owners MAY deliberately override their unit. We don't block
  // them — but we only record an explicit owner override when their choice
  // diverges from the shop's automatic (country / safe-default) unit. When the
  // choice matches the default, we mark the source "auto" so an incidental save
  // (e.g. changing timezone) never silently pins the unit and the shop keeps
  // following its location. This is the deliberate-intent flag the resolver
  // (resolveShopDistanceUnit) honors above country.
  if (distanceUnit) {
    const shopForGuard = await db.collection("shops").findOne(
      { shopId: Number(sess.shopId) },
      { projection: { integrationProvider: 1, smsProvider: 1, geo: 1 } }
    );
    updates["preferences.distanceUnit"] = distanceUnit;
    updates["preferences.distanceUnitSource"] = isOverrideUnit(shopForGuard, distanceUnit)
      ? "owner"
      : "auto";
  }
  if (timezone) updates["preferences.timezone"] = timezone;
  if (workflowStages !== undefined) updates["preferences.workflowStages"] = workflowStages;
  if (showInspectItems !== undefined) updates["preferences.showInspectItems"] = showInspectItems;
  if (showOnlyWithMileage !== undefined) updates["preferences.showOnlyWithMileage"] = showOnlyWithMileage;
  if (showRecalls !== undefined) updates["preferences.showRecalls"] = showRecalls;
  if (recallsExpanded !== undefined) updates["preferences.recallsExpanded"] = recallsExpanded;
  if (tekmetricLabels !== undefined) updates["preferences.tekmetricLabels"] = tekmetricLabels;
  if (jobHistoryShopIds !== undefined) updates["preferences.jobHistoryShopIds"] = jobHistoryShopIds;
  if (shopwareAddMode !== undefined) {
    const validModes = ["finding-published", "finding-draft", "add-service"];
    if (!validModes.includes(shopwareAddMode)) {
      return NextResponse.json({ error: "Invalid Shop-Ware add mode" }, { status: 400 });
    }
    updates["preferences.shopwareAddMode"] = shopwareAddMode;
  }

  // Floating Detect Dog launcher (per-shop owner switch). A boolean records an
  // explicit owner choice; null clears it so the shop falls back to the default
  // (off when only oil-sticker/keytag features are enabled, otherwise on).
  const unsets: Record<string, any> = {};
  if (floatingDetectDogEnabled === null) {
    unsets["preferences.floatingDetectDogEnabled"] = "";
  } else if (typeof floatingDetectDogEnabled === "boolean") {
    updates["preferences.floatingDetectDogEnabled"] = floatingDetectDogEnabled;
  }

  const ops: Record<string, any> = {};
  if (Object.keys(updates).length > 0) ops.$set = updates;
  if (Object.keys(unsets).length > 0) ops.$unset = unsets;

  if (Object.keys(ops).length > 0) {
    await db.collection("shops").updateOne(
      { shopId: Number(sess.shopId) },
      ops
    );
  }

  return NextResponse.json({ success: true });
}
