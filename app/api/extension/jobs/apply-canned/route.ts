import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus } from "@/lib/extension-auth";
import { getDb } from "@/lib/mongo";
import {
  applyCannedJobToWorkOrder,
  fetchVehicleByVin,
  fetchWorkOrdersForVehicle,
  resolveProtractorConfig,
  protractorFetch,
} from "@/lib/integrations/protractor";
import { trackPushToRO } from "@/lib/extension-analytics";

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
  try {
    const auth = await validateExtensionToken(req);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: getAuthErrorStatus(auth), headers: corsHeaders }
      );
    }

    const body = await req.json();
    const { shopId, roNumber, vin, cannedJobId, cannedJobTitle } = body as {
      shopId: number;
      roNumber?: string;
      vin?: string;
      cannedJobId: string;
      cannedJobTitle?: string;
    };

    if (!shopId) {
      return NextResponse.json(
        { error: "shopId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const userShopIds = getUserShopIds(auth.user).map((id) => Number(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";
    if (!isPlatformAdmin && !userShopIds.includes(Number(shopId))) {
      return NextResponse.json(
        { error: "Not authorized for this shop" },
        { status: 403, headers: corsHeaders }
      );
    }

    if (!cannedJobId) {
      return NextResponse.json(
        { error: "cannedJobId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const sanitizedRoNumber = roNumber ? roNumber.replace(/[^a-zA-Z0-9\-_]/g, "") : undefined;

    console.log(`[Ext Apply Canned] shop=${shopId} roNumber=${sanitizedRoNumber} vin=${vin} cannedJobId=${cannedJobId}`);

    let targetWorkOrderId: string | undefined;

    if (sanitizedRoNumber) {
      const config = await resolveProtractorConfig(shopId);
      if (config.configured) {
        const searchResult = await protractorFetch<any>(
          `/WorkOrder?$filter=WorkOrderNumber eq '${sanitizedRoNumber}'&$top=5`,
          config,
          {},
          0,
          shopId
        );

        if (searchResult.ok && searchResult.data) {
          const items = Array.isArray(searchResult.data)
            ? searchResult.data
            : searchResult.data?.Items || searchResult.data?.value || [];
          const openWo = items.find(
            (wo: any) =>
              !wo.Completed &&
              (String(wo.WorkOrderNumber) === String(sanitizedRoNumber) || String(wo.Number) === String(sanitizedRoNumber))
          );
          if (openWo) {
            targetWorkOrderId = openWo.ID || openWo.Guid;
            console.log(`[Ext Apply Canned] Found WO by RO# ${sanitizedRoNumber}: ${targetWorkOrderId}`);
          }
        }
      }
    }

    if (!targetWorkOrderId && vin) {
      const vehicleResult = await fetchVehicleByVin(shopId, vin);
      if (vehicleResult.ok && vehicleResult.vehicle) {
        const woResult = await fetchWorkOrdersForVehicle(shopId, vehicleResult.vehicle.ID, {
          includeOpen: true,
        });
        if (woResult.ok) {
          const openWos = (woResult.workOrders || []).filter((wo: any) => !wo.Completed);
          if (openWos.length > 0) {
            targetWorkOrderId = openWos[0].ID;
            console.log(`[Ext Apply Canned] Found WO by VIN ${vin}: ${targetWorkOrderId}`);
          }
        }
      }
    }

    if (!targetWorkOrderId) {
      return NextResponse.json(
        {
          error: sanitizedRoNumber
            ? `No open work order found for RO# ${sanitizedRoNumber}`
            : "No open work order found for this vehicle",
          requiresManualEntry: true,
        },
        { status: 404, headers: corsHeaders }
      );
    }

    const result = await applyCannedJobToWorkOrder(shopId, targetWorkOrderId, cannedJobId, cannedJobTitle);

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || "Failed to apply canned job" },
        { status: 500, headers: corsHeaders }
      );
    }

    const db = await getDb();
    await db.collection("canned_job_applications").insertOne({
      shopId,
      vin: vin?.toUpperCase() || null,
      roNumber: roNumber || null,
      workOrderId: targetWorkOrderId,
      cannedJobId,
      servicePackageId: result.servicePackage?.ID || null,
      appliedAt: new Date(),
      appliedBy: auth.user.email || null,
      source: "extension",
    });

    trackPushToRO({
      shopId,
      userId: auth.user.email || undefined,
      vin: vin?.toUpperCase(),
      jobTitle: cannedJobTitle || cannedJobId,
      jobSource: "canned_extension_protractor",
      repairOrderId: String(targetWorkOrderId),
    }).catch((err) => console.error("[Ext Apply Canned] Analytics failed:", err));

    return NextResponse.json(
      {
        success: true,
        jobName: cannedJobTitle || cannedJobId,
        workOrderId: targetWorkOrderId,
        servicePackage: result.servicePackage,
      },
      { headers: corsHeaders }
    );
  } catch (err: any) {
    console.error("[Ext Apply Canned] Error:", err.message);
    return NextResponse.json(
      { error: err.message || "Internal server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}
