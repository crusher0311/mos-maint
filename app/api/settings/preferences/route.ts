import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_WORKFLOW_STAGES = ["InspectionInProgress", "Unassigned", "WorkAuthorized", "EstimateCompleted"];

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: Number(sess.shopId) });

  return NextResponse.json({
    distanceUnit: shop?.preferences?.distanceUnit || "miles",
    timezone: shop?.preferences?.timezone || "America/New_York",
    workflowStages: shop?.preferences?.workflowStages || DEFAULT_WORKFLOW_STAGES,
    showInspectItems: shop?.preferences?.showInspectItems !== false, // default true
    showOnlyWithMileage: shop?.preferences?.showOnlyWithMileage !== false, // default true
    tekmetricLabels: shop?.preferences?.tekmetricLabels || [], // empty = show all
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

  const { distanceUnit, timezone, workflowStages, showInspectItems, showOnlyWithMileage, tekmetricLabels } = await req.json();

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
  if (tekmetricLabels !== undefined) updates["preferences.tekmetricLabels"] = tekmetricLabels;

  await db.collection("shops").updateOne(
    { shopId: Number(sess.shopId) },
    { $set: updates }
  );

  return NextResponse.json({ success: true });
}
