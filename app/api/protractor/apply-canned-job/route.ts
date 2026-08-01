import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { insertCannedJobApplication } from "@/lib/data/repositories/canned-jobs";
import {
  applyCannedJobToWorkOrder,
  fetchVehicleByVin,
  fetchWorkOrdersForVehicle,
} from "@/lib/integrations/protractor";
import { logRecommendationEvent } from "@/lib/enterprise";
import { trackPushToRO } from "@/lib/extension-analytics";
import {
  validateExtensionToken,
  getAuthErrorStatus,
  buildAuthErrorBody,
} from "@/lib/extension-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  // Dual auth: the Chrome extension sends a `Bearer ext_` token (no session
  // cookie), the dashboard sends a session cookie. Without the ext-token
  // branch this route 401s every extension request — and because the
  // middleware now allowlists this path (Task #734), the route is the ONLY
  // line of defense, so it must validate the token itself.
  let sessionEmail: string | null = null;
  let shopId: number;

  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ext_")) {
    const extAuth = await validateExtensionToken(req);
    if (!extAuth.authorized || !extAuth.user) {
      return NextResponse.json(
        buildAuthErrorBody(extAuth),
        { status: getAuthErrorStatus(extAuth), headers: corsHeaders },
      );
    }
    sessionEmail = extAuth.user.email ?? null;
    shopId = Number(extAuth.user.shopId);
  } else {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }
    sessionEmail = session.email;
    shopId = Number(session.shopId);
  }

  const db = await getDb();
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400, headers: corsHeaders });
  }

  let body: { vin?: string; cannedJobId?: string; cannedJobTitle?: string; workOrderId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
  }

  const { vin, cannedJobId, cannedJobTitle, workOrderId } = body;
  const requestStart = Date.now();
  console.log(`[Apply Canned Job] Request: vin=${vin}, cannedJobId=${cannedJobId}, workOrderId=${workOrderId}`);

  if (!cannedJobId) {
    return NextResponse.json({ error: "cannedJobId is required" }, { status: 400, headers: corsHeaders });
  }

  let targetWorkOrderId = workOrderId;

  if (!targetWorkOrderId && vin) {
    // Only hit the VIN→vehicle→work-orders chain when the caller didn't
    // already supply a work-order handle — each hop is an upstream round-trip.
    console.log(`[Apply Canned Job] Looking up vehicle by VIN: ${vin}`);
    const vinLookupStart = Date.now();
    const vehicleResult = await fetchVehicleByVin(shopId, vin);
    if (!vehicleResult.ok || !vehicleResult.vehicle) {
      console.log(`[Apply Canned Job] Vehicle not found: ${vehicleResult.error}`);
      return NextResponse.json(
        { error: vehicleResult.error || "Vehicle not found in Protractor" },
        { status: 404, headers: corsHeaders }
      );
    }

    const serviceItemId = vehicleResult.vehicle.ID;
    console.log(`[Apply Canned Job] Found vehicle, ServiceItemID: ${serviceItemId}`);
    
    const workOrdersResult = await fetchWorkOrdersForVehicle(shopId, serviceItemId, {
      includeOpen: true,
    });

    if (!workOrdersResult.ok) {
      console.log(`[Apply Canned Job] Failed to fetch work orders: ${workOrdersResult.error}`);
      if (workOrdersResult.error === "WORK_ORDER_LOOKUP_NOT_AVAILABLE") {
        return NextResponse.json(
          { 
            error: "Work order lookup not available. Please enter the RO number manually.",
            requiresManualEntry: true
          },
          { status: 400, headers: corsHeaders }
        );
      }
      return NextResponse.json(
        { error: workOrdersResult.error || "Failed to fetch work orders" },
        { status: 500, headers: corsHeaders }
      );
    }

    const openWorkOrders = (workOrdersResult.workOrders || []).filter(
      (wo) => !wo.Completed
    );
    console.log(`[Apply Canned Job] Found ${openWorkOrders.length} open work orders`);

    if (openWorkOrders.length === 0) {
      return NextResponse.json(
        { 
          error: "No open work order found for this vehicle. Please enter the RO number manually.",
          requiresManualEntry: true
        },
        { status: 400, headers: corsHeaders }
      );
    }

    targetWorkOrderId = openWorkOrders[0].ID;
    console.log(`[Apply Canned Job] Using work order ID: ${targetWorkOrderId} (VIN→WO discovery took ${Date.now() - vinLookupStart}ms)`);
  }

  if (!targetWorkOrderId) {
    return NextResponse.json(
      { error: "Either workOrderId or vin must be provided" },
      { status: 400, headers: corsHeaders }
    );
  }

  const applyStart = Date.now();
  const result = await applyCannedJobToWorkOrder(shopId, targetWorkOrderId, cannedJobId, cannedJobTitle);
  console.log(`[Apply Canned Job] applyCannedJobToWorkOrder took ${Date.now() - applyStart}ms (ok=${result.ok}, request total ${Date.now() - requestStart}ms)`);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500, headers: corsHeaders });
  }

  await insertCannedJobApplication({
    shopId,
    vin: vin?.toUpperCase() || null,
    workOrderId: targetWorkOrderId,
    cannedJobId,
    servicePackageId: result.servicePackage?.ID || null,
    appliedAt: new Date(),
    appliedBy: sessionEmail || null,
  });

  try {
    await logRecommendationEvent({
      shopId,
      vin: vin?.toUpperCase() || "",
      workOrderId: String(targetWorkOrderId),
      provider: "protractor",
      eventType: "recommendation_added",
      recommendationType: "shop",
      serviceCode: cannedJobId,
      serviceName: cannedJobTitle || cannedJobId,
      addedBy: sessionEmail || undefined,
    });
  } catch (err) {
    console.error("[Apply Canned Job] Failed to log recommendation event:", err);
  }

  trackPushToRO({
    shopId,
    userId: sessionEmail || undefined,
    vin: vin?.toUpperCase(),
    jobTitle: cannedJobTitle || cannedJobId,
    jobSource: "canned",
    repairOrderId: String(targetWorkOrderId),
  }).catch(err => console.error("[Apply Canned Job] Analytics tracking failed:", err));

  return NextResponse.json({
    success: true,
    workOrderId: targetWorkOrderId,
    servicePackage: result.servicePackage,
  }, { headers: corsHeaders });
}
