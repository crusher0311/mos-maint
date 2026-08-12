import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus , buildAuthErrorBody } from "@/lib/extension-auth";
import { insertCannedJobApplication } from "@/lib/data/repositories/canned-jobs";
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

async function _POST(req: NextRequest) {
  try {
    const auth = await validateExtensionToken(req);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        buildAuthErrorBody(auth),
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

    // Task #512 — synthetic prod smoke. When `_synthetic` is set we DO
    // run the upstream WO lookup below (so the smoke covers the path
    // that broke for Kurt — canned-jobs lookup → vehicle-by-VIN →
    // open-WO search), and only short-circuit immediately before the
    // destructive `applyCannedJobToWorkOrder(...)` call. We must not
    // push a fake job into a real customer RO in the third-party SMS.
    const isSynthetic =
      req.nextUrl.searchParams.get("_synthetic") === "1" ||
      (body as any)?._synthetic === true;

    const sanitizedRoNumber = roNumber ? roNumber.replace(/[^a-zA-Z0-9\-_]/g, "") : undefined;

    console.log(`[Ext Apply Canned] shop=${shopId} roNumber=${sanitizedRoNumber} vin=${vin} cannedJobId=${cannedJobId}`);

    let targetWorkOrderId: string | undefined;
    // Track each upstream leg's outcome so the synthetic can distinguish
    // "lookup ran cleanly, no open WO" (sentinel just quiet — ok) from
    // "lookup itself errored" (real regression — must fail the smoke).
    type LegOutcome =
      | "ran_found"
      | "ran_empty"
      | "errored"
      | "skipped_not_configured"
      | "skipped_no_input";
    const lookupOutcomes: { protractor: LegOutcome; vin: LegOutcome } = {
      protractor: "skipped_no_input",
      vin: "skipped_no_input",
    };
    const lookupErrors: string[] = [];

    if (sanitizedRoNumber) {
      const config = await resolveProtractorConfig(shopId);
      if (!config.configured) {
        lookupOutcomes.protractor = "skipped_not_configured";
      } else {
        try {
          const searchResult = await protractorFetch<any>(
            `/WorkOrder?$filter=WorkOrderNumber eq '${sanitizedRoNumber}'&$top=5`,
            config,
            {},
            0,
            shopId
          );

          if (!searchResult.ok) {
            lookupOutcomes.protractor = "errored";
            lookupErrors.push(`protractor: ${searchResult.error || "unknown"}`);
          } else {
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
              lookupOutcomes.protractor = "ran_found";
              console.log(`[Ext Apply Canned] Found WO by RO# ${sanitizedRoNumber}: ${targetWorkOrderId}`);
            } else {
              lookupOutcomes.protractor = "ran_empty";
            }
          }
        } catch (err: any) {
          lookupOutcomes.protractor = "errored";
          lookupErrors.push(`protractor: ${err?.message || String(err)}`);
        }
      }
    }

    if (!targetWorkOrderId && vin) {
      try {
        const vehicleResult = await fetchVehicleByVin(shopId, vin);
        if (!vehicleResult.ok) {
          lookupOutcomes.vin = "errored";
          lookupErrors.push(`vehicle: ${(vehicleResult as any).error || "unknown"}`);
        } else if (!vehicleResult.vehicle) {
          lookupOutcomes.vin = "ran_empty";
        } else {
          const woResult = await fetchWorkOrdersForVehicle(shopId, vehicleResult.vehicle.ID, {
            includeOpen: true,
          });
          if (!woResult.ok) {
            lookupOutcomes.vin = "errored";
            lookupErrors.push(`workorders: ${(woResult as any).error || "unknown"}`);
          } else {
            const openWos = (woResult.workOrders || []).filter((wo: any) => !wo.Completed);
            if (openWos.length > 0) {
              targetWorkOrderId = openWos[0].ID;
              lookupOutcomes.vin = "ran_found";
              console.log(`[Ext Apply Canned] Found WO by VIN ${vin}: ${targetWorkOrderId}`);
            } else {
              lookupOutcomes.vin = "ran_empty";
            }
          }
        }
      } catch (err: any) {
        lookupOutcomes.vin = "errored";
        lookupErrors.push(`vehicle: ${err?.message || String(err)}`);
      }
    }

    // Task #512 — synthetic outcome contract:
    //  - any leg `errored` → 502 with `synthetic:false`, runner must fail
    //  - at least one leg `ran_found` or `ran_empty` → 200 with
    //    `synthetic:true` + `lookup_ok:true`
    //  - everything `skipped_*` → 502 (no upstream leg actually ran, so
    //    the smoke proved nothing)
    if (isSynthetic) {
      const anyError = lookupOutcomes.protractor === "errored" || lookupOutcomes.vin === "errored";
      const anyRan =
        lookupOutcomes.protractor === "ran_found" ||
        lookupOutcomes.protractor === "ran_empty" ||
        lookupOutcomes.vin === "ran_found" ||
        lookupOutcomes.vin === "ran_empty";
      if (anyError) {
        return NextResponse.json(
          {
            ok: false,
            synthetic: true,
            lookup_ok: false,
            lookupOutcomes,
            errors: lookupErrors,
          },
          { status: 502, headers: corsHeaders },
        );
      }
      if (!anyRan) {
        return NextResponse.json(
          {
            ok: false,
            synthetic: true,
            lookup_ok: false,
            error: "no upstream lookup leg ran (sentinel mis-configured?)",
            lookupOutcomes,
          },
          { status: 502, headers: corsHeaders },
        );
      }
      return NextResponse.json(
        {
          ok: true,
          synthetic: true,
          lookup_ok: true,
          skipped: targetWorkOrderId ? "synthetic_pre_write" : "synthetic_no_open_wo",
          targetWorkOrderId: targetWorkOrderId || null,
          lookupOutcomes,
          shopId,
        },
        { headers: corsHeaders },
      );
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

    await insertCannedJobApplication({
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
        // Task #1094: lets the side panel snapshot this add for undo.
        servicePackageId: result.servicePackage?.ID || null,
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

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
