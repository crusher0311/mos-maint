import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getEnterpriseByShopId } from "@/lib/enterprise";

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
    showInspectItems: shop?.preferences?.showInspectItems !== false, // default true
    showOnlyWithMileage: shop?.preferences?.showOnlyWithMileage !== false, // default true
    showRecalls: shop?.preferences?.showRecalls !== false, // default true
    recallsExpanded: shop?.preferences?.recallsExpanded !== false, // default true
    tekmetricLabels: shop?.preferences?.tekmetricLabels || [], // empty = show all
    jobHistoryShopIds: shop?.preferences?.jobHistoryShopIds || null, // null = all enterprise shops
    quickSpecsDisplay: shop?.preferences?.quickSpecsDisplay || {
      fuelTank: true,
      maxTowing: true,
      payload: true,
      tires: true,
      frontBrake: false,
      bedLength: false,
    },
    enterpriseShops, // for UI to display options
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

  const { distanceUnit, timezone, workflowStages, showInspectItems, showOnlyWithMileage, showRecalls, recallsExpanded, tekmetricLabels, jobHistoryShopIds, quickSpecsDisplay } = await req.json();

  if (distanceUnit && !["miles", "kilometers"].includes(distanceUnit)) {
    return NextResponse.json({ error: "Invalid distance unit" }, { status: 400 });
  }

  if (workflowStages && (!Array.isArray(workflowStages) || !workflowStages.every(s => VALID_WORKFLOW_STAGES.includes(s)))) {
    return NextResponse.json({ error: "Invalid workflow stages" }, { status: 400 });
  }

  const db = await getDb();
  const updates: Record<string, any> = {};

  if (distanceUnit) updates["preferences.distanceUnit"] = distanceUnit;
  if (timezone) updates["preferences.timezone"] = timezone;
  if (workflowStages !== undefined) updates["preferences.workflowStages"] = workflowStages;
  if (showInspectItems !== undefined) updates["preferences.showInspectItems"] = showInspectItems;
  if (showOnlyWithMileage !== undefined) updates["preferences.showOnlyWithMileage"] = showOnlyWithMileage;
  if (showRecalls !== undefined) updates["preferences.showRecalls"] = showRecalls;
  if (recallsExpanded !== undefined) updates["preferences.recallsExpanded"] = recallsExpanded;
  if (tekmetricLabels !== undefined) updates["preferences.tekmetricLabels"] = tekmetricLabels;
  if (jobHistoryShopIds !== undefined) updates["preferences.jobHistoryShopIds"] = jobHistoryShopIds;
  if (quickSpecsDisplay !== undefined) updates["preferences.quickSpecsDisplay"] = quickSpecsDisplay;

  await db.collection("shops").updateOne(
    { shopId: Number(sess.shopId) },
    { $set: updates }
  );

  return NextResponse.json({ success: true });
}
