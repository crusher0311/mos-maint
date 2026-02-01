import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getEnterpriseByShopId } from "@/lib/enterprise-pg";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_WORKFLOW_STAGES = ["InspectionInProgress", "Unassigned", "WorkAuthorized", "EstimateCompleted"];

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const shopId = String(sess.shopId);
  const shopResult = await sql`SELECT * FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
  const shop = shopResult[0];
  const settings = shop?.settings as Record<string, unknown> | null;
  const preferences = settings?.preferences as Record<string, unknown> | null;
  
  let enterpriseShops: { shopId: number; name: string; locationIdentifier: string | null }[] = [];
  const enterprise = await getEnterpriseByShopId(Number(sess.shopId));
  if (enterprise && enterprise.shop_ids.length > 1) {
    const siblingShops = await sql`
      SELECT shop_id, name, location_identifier 
      FROM shops 
      WHERE shop_id = ANY(${enterprise.shop_ids.map(String)})
    `;
    enterpriseShops = siblingShops.map(s => ({ 
      shopId: s.shop_id ? parseInt(s.shop_id, 10) : 0, 
      name: s.name,
      locationIdentifier: s.location_identifier || null
    }));
  }

  return NextResponse.json({
    distanceUnit: (preferences?.distanceUnit as string) || "miles",
    timezone: (preferences?.timezone as string) || "America/New_York",
    workflowStages: (preferences?.workflowStages as string[]) || DEFAULT_WORKFLOW_STAGES,
    showInspectItems: preferences?.showInspectItems !== false,
    showOnlyWithMileage: preferences?.showOnlyWithMileage !== false,
    showRecalls: preferences?.showRecalls !== false,
    recallsExpanded: preferences?.recallsExpanded !== false,
    tekmetricLabels: (preferences?.tekmetricLabels as string[]) || [],
    jobHistoryShopIds: preferences?.jobHistoryShopIds || null,
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

  const { distanceUnit, timezone, workflowStages, showInspectItems, showOnlyWithMileage, showRecalls, recallsExpanded, tekmetricLabels, jobHistoryShopIds } = await req.json();

  if (distanceUnit && !["miles", "kilometers"].includes(distanceUnit)) {
    return NextResponse.json({ error: "Invalid distance unit" }, { status: 400 });
  }

  if (workflowStages && (!Array.isArray(workflowStages) || !workflowStages.every(s => VALID_WORKFLOW_STAGES.includes(s)))) {
    return NextResponse.json({ error: "Invalid workflow stages" }, { status: 400 });
  }

  const shopId = String(sess.shopId);
  const shopResult = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
  const existingSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};
  const existingPreferences = (existingSettings.preferences as Record<string, unknown>) || {};

  const updatedPreferences = { ...existingPreferences };
  if (distanceUnit) updatedPreferences.distanceUnit = distanceUnit;
  if (timezone) updatedPreferences.timezone = timezone;
  if (workflowStages !== undefined) updatedPreferences.workflowStages = workflowStages;
  if (showInspectItems !== undefined) updatedPreferences.showInspectItems = showInspectItems;
  if (showOnlyWithMileage !== undefined) updatedPreferences.showOnlyWithMileage = showOnlyWithMileage;
  if (showRecalls !== undefined) updatedPreferences.showRecalls = showRecalls;
  if (recallsExpanded !== undefined) updatedPreferences.recallsExpanded = recallsExpanded;
  if (tekmetricLabels !== undefined) updatedPreferences.tekmetricLabels = tekmetricLabels;
  if (jobHistoryShopIds !== undefined) updatedPreferences.jobHistoryShopIds = jobHistoryShopIds;

  const updatedSettings = { ...existingSettings, preferences: updatedPreferences };

  await sql`
    UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb, updated_at = ${new Date()}
    WHERE shop_id = ${shopId}
  `;

  return NextResponse.json({ success: true });
}
