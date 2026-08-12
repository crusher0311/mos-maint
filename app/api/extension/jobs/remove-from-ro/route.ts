// Task #1094 — undo for side-panel Protractor adds.
//
// The side panel snapshots the `servicePackageId` returned by the add-to-ro /
// apply-canned routes; this endpoint reverts that add by re-POSTing the work
// order with the package filtered out — the exact mirror of how the add was
// written (same minimal payload builder, same SOAP fallback).
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import {
  validateExtensionToken,
  getUserShopIds,
  getAuthErrorStatus,
  buildAuthErrorBody,
} from "@/lib/extension-auth";
import {
  resolveProtractorConfig,
  protractorFetch,
  fetchWorkOrderById,
  buildMinimalPayloadForRemove,
  soapAddServicePackage,
} from "@/lib/integrations/protractor";

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function _POST(req: NextRequest) {
  const requestId = Math.random().toString(36).substring(7);
  try {
    const auth = await validateExtensionToken(req);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(buildAuthErrorBody(auth), {
        status: getAuthErrorStatus(auth),
        headers: corsHeaders,
      });
    }

    const body = await req.json();
    const { shopId, workOrderId, servicePackageId } = body as {
      shopId: number;
      workOrderId: string;
      servicePackageId: string;
    };

    if (!shopId || !workOrderId || !servicePackageId) {
      return NextResponse.json(
        { error: "shopId, workOrderId and servicePackageId are required" },
        { status: 400, headers: corsHeaders }
      );
    }
    if (!UUID_RE.test(String(workOrderId)) || !UUID_RE.test(String(servicePackageId))) {
      return NextResponse.json(
        { error: "workOrderId and servicePackageId must be GUIDs" },
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

    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return NextResponse.json(
        { error: "Protractor is not configured for this shop" },
        { status: 400, headers: corsHeaders }
      );
    }

    const woResult = await fetchWorkOrderById(shopId, workOrderId, { priority: true });
    if (!woResult.ok || !woResult.workOrder) {
      return NextResponse.json(
        { error: woResult.error || "Work order not found" },
        { status: 404, headers: corsHeaders }
      );
    }
    const existingWorkOrder = woResult.workOrder as any;

    // Same guard as the add path — never touch a completed/invoiced WO.
    const workOrderStage = existingWorkOrder.WorkflowStage || existingWorkOrder.workflowStage;
    const blockedStages = ["WorkCompleted", "Invoiced", "Void", "Closed"];
    if (blockedStages.includes(workOrderStage)) {
      return NextResponse.json(
        {
          error: `Cannot undo on this work order — it is ${workOrderStage
            .replace(/([A-Z])/g, " $1")
            .trim()
            .toLowerCase()}`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const pkgsRaw = existingWorkOrder.ServicePackages as any;
    const packages: any[] = Array.isArray(pkgsRaw) ? pkgsRaw : pkgsRaw?.ItemCollection || [];
    const target = packages.find(
      (p) => String(p?.ID || "").toLowerCase() === String(servicePackageId).toLowerCase()
    );
    if (!target) {
      // Already gone (removed in the SMS, or a retried undo) — treat as done.
      console.log(`[Ext Remove-from-RO:${requestId}] Package ${servicePackageId} not on WO ${workOrderId} — nothing to remove`);
      return NextResponse.json(
        { success: true, alreadyRemoved: true },
        { headers: corsHeaders }
      );
    }

    const remaining = packages.filter((p) => p !== target);
    const updatedWorkOrder = buildMinimalPayloadForRemove(existingWorkOrder, remaining);

    console.log(
      `[Ext Remove-from-RO:${requestId}] shop=${shopId} wo=${workOrderId} removing package ${servicePackageId} ("${target?.ServicePackageHeader?.Title || ""}"), ${remaining.length} remain`
    );

    const updateResult = await protractorFetch<any>(
      `/WorkOrder/${workOrderId}`,
      config,
      { method: "POST", body: JSON.stringify(updatedWorkOrder) },
      0,
      shopId,
      { priority: true }
    );

    if (!updateResult.ok) {
      // Mirror the add path's SOAP fallback for the known Status-column bug.
      const isStatusColumnError = (updateResult.error || "").includes("Invalid column name 'Status'");
      if (isStatusColumnError) {
        const soapResult = await soapAddServicePackage(shopId, workOrderId, updatedWorkOrder);
        if (!soapResult.ok) {
          return NextResponse.json(
            { error: "Failed to undo — Protractor database issue. Please remove the job in Protractor manually." },
            { status: 500, headers: corsHeaders }
          );
        }
      } else {
        return NextResponse.json(
          { error: updateResult.error || "Failed to remove job from work order" },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    console.log(`[Ext Remove-from-RO:${requestId}] Removed package ${servicePackageId} from WO ${workOrderId}`);
    return NextResponse.json(
      { success: true, removedTitle: target?.ServicePackageHeader?.Title || null },
      { headers: corsHeaders }
    );
  } catch (err: any) {
    console.error(`[Ext Remove-from-RO:${requestId}] Error:`, err.message);
    return NextResponse.json(
      { error: err.message || "Internal server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}

export const POST = withExtensionErrorMarker(_POST);
