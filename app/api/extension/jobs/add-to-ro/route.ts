import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus, buildAuthErrorBody, requireExtensionPrincipalScope } from "@/lib/extension-auth";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  protractorFetch,
  fetchWorkOrderById,
  buildMinimalPayloadForPost,
  soapAddServicePackage,
} from "@/lib/integrations/protractor";
import {
  getShopPartCostRatio,
  resolvePartLineCost,
  logPartCostResolution,
} from "@/lib/integrations/protractor/part-cost";
import { trackPushToRO } from "@/lib/extension-analytics";
import {
  getJobLaborRate,
  needsCachedLaborRate,
  resolveAddToRoLaborRate,
} from "@/lib/integrations/protractor/labor-rate";

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
  const requestId = Math.random().toString(36).substring(7);

  try {
    const auth = await validateExtensionToken(req);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        buildAuthErrorBody(auth),
        { status: getAuthErrorStatus(auth), headers: corsHeaders }
      );
    }

    const body = await req.json();
    const { shopId, provider, roNumber, vin, job, source, workOrderGuid: workOrderGuidHint } = body as {
      shopId: number;
      provider?: string;
      roNumber?: string;
      vin?: string;
      workOrderGuid?: string;
      // Task #888 — where the pushed job came from. "canned" makes the
      // template's own labor rate win over the RO/cached shop rate.
      source?: string;
      job: {
        title: string;
        description?: string;
        code?: string;
        lines?: Array<{
          lineType: "labor" | "part" | "sublet" | "other";
          description: string;
          partNumber?: string;
          manufacturer?: string;
          quantity: number;
          unitPrice: number;
          extendedPrice: number;
          // Task #681 — real per-unit part cost from the source system.
          cost?: number;
          extendedCost?: number;
        }>;
        // Task #888 — `rate` carries the template's own labor rate for
        // canned jobs (older extension builds omit it).
        laborItems?: Array<{ name: string; hours: number; rate?: number }>;
        parts?: Array<{
          name: string;
          partNumber?: string;
          brand?: string;
          quantity: number;
          cost: number;
          retail: number;
          // Task #681 — real cost. The legacy `cost` field above is NOT
          // trusted for cost writing: old extension builds fill it with
          // retail as a fallback, which would write a 0%-GP cost.
          unitCost?: number;
        }>;
      };
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

    const scopedProvider = String(provider || "protractor")
      .toLowerCase()
      .replace(/^shop[-_]ware$/, "shopware");
    if (!["protractor", "autoflow"].includes(scopedProvider)) {
      return NextResponse.json(
        { error: "Provider scope mismatch", code: "PROVIDER_FORBIDDEN" },
        { status: 403, headers: corsHeaders },
      );
    }
    const scopeFailure = requireExtensionPrincipalScope(auth, {
      shopId,
      provider: scopedProvider,
    });
    if (scopeFailure) {
      return NextResponse.json(
        buildAuthErrorBody(scopeFailure),
        { status: getAuthErrorStatus(scopeFailure), headers: corsHeaders }
      );
    }

    if (!job || !job.title) {
      return NextResponse.json(
        { error: "Job details with title are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const sanitizedRoNumber = roNumber ? roNumber.replace(/[^a-zA-Z0-9\-_]/g, "") : undefined;

    console.log(`[Ext Add-to-RO:${requestId}] shop=${shopId} roNumber=${sanitizedRoNumber} vin=${vin} job="${job.title}"`);

    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return NextResponse.json(
        { error: "Protractor is not configured for this shop" },
        { status: 400, headers: corsHeaders }
      );
    }

    let workOrderGuid: string | null = null;

    // Reuse the WO GUID captured at Create-RO time when present. Protractor's
    // OData WorkOrderNumber search does NOT return open work orders (confirmed
    // live: an open WO returns 0 hits by number), and the VIN->cached-WO
    // fallback lags for a freshly created RO, so a brand-new RO would otherwise
    // 404 here. The GUID is the only reliable handle right after creation.
    if (typeof workOrderGuidHint === "string" && workOrderGuidHint.trim()) {
      const candidate = workOrderGuidHint.trim();
      // Validate the GUID shape before using it in a path-construction sink
      // (/WorkOrder/{guid}). A malformed hint is ignored, not fatal — we just
      // fall through to the normal RO-number / VIN lookup below.
      const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(candidate);
      if (isUuid) {
        workOrderGuid = candidate;
        console.log(`[Ext Add-to-RO:${requestId}] Using WO GUID from create-RO hint: ${workOrderGuid}`);
      } else {
        console.warn(`[Ext Add-to-RO:${requestId}] Ignoring malformed workOrderGuid hint; falling back to lookup`);
      }
    }

    if (!workOrderGuid && sanitizedRoNumber) {
      const searchResult = await protractorFetch<any>(
        `/WorkOrder?$filter=WorkOrderNumber eq '${sanitizedRoNumber}'&$top=5`,
        config,
        {},
        0,
        shopId,
        { priority: true }
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
          workOrderGuid = openWo.ID || openWo.Guid;
          console.log(`[Ext Add-to-RO:${requestId}] Found WO by RO# ${sanitizedRoNumber}: ${workOrderGuid}`);
        }
      }
    }

    if (!workOrderGuid && vin) {
      const { fetchVehicleByVin, fetchWorkOrdersForVehicle } = await import("@/lib/integrations/protractor");
      const vehicleResult = await fetchVehicleByVin(shopId, vin);
      if (vehicleResult.ok && vehicleResult.vehicle) {
        const woResult = await fetchWorkOrdersForVehicle(shopId, vehicleResult.vehicle.ID, {
          includeOpen: true,
        });
        if (woResult.ok) {
          const openWos = (woResult.workOrders || []).filter((wo: any) => !wo.Completed);
          if (openWos.length > 0) {
            workOrderGuid = openWos[0].ID;
            console.log(`[Ext Add-to-RO:${requestId}] Found WO by VIN ${vin}: ${workOrderGuid}`);
          }
        }
      }
    }

    if (!workOrderGuid) {
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

    const fetchWOStart = Date.now();
    const existingWOResult = await fetchWorkOrderById(shopId, workOrderGuid, { priority: true });
    console.log(`[Ext Add-to-RO:${requestId}] WO fetch took ${Date.now() - fetchWOStart}ms`);

    if (!existingWOResult.ok || !existingWOResult.workOrder) {
      return NextResponse.json(
        { error: existingWOResult.error || "Work order not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    const existingWorkOrder = existingWOResult.workOrder;
    const workOrderStage = existingWorkOrder.WorkflowStage || (existingWorkOrder as any).workflowStage;
    const blockedStages = ["WorkCompleted", "Invoiced", "Void", "Closed"];
    if (blockedStages.includes(workOrderStage)) {
      return NextResponse.json(
        { error: `Cannot add to this work order — it is ${workOrderStage.replace(/([A-Z])/g, " $1").trim().toLowerCase()}` },
        { status: 400, headers: corsHeaders }
      );
    }

    const existingPackagesRaw = existingWorkOrder.ServicePackages as any;
    const existingPackages = Array.isArray(existingPackagesRaw)
      ? existingPackagesRaw
      : existingPackagesRaw?.ItemCollection || [];

    // Task #888 — labor-rate resolution via the shared helper: canned jobs
    // keep their template rate; other sources keep RO → cached → job rate.
    const jobLaborRate = getExtensionJobLaborRate(job);

    let roLaborRate = 0;
    for (const pkg of existingPackages) {
      const linesRaw = pkg.ServicePackageLines;
      const lines = Array.isArray(linesRaw) ? linesRaw : linesRaw?.ItemCollection || [];
      for (const line of lines) {
        if ((line.Type === "Labor" || line.LineType === "Labor") && line.Price && parseFloat(line.Price) > 0) {
          roLaborRate = parseFloat(line.Price);
          break;
        }
      }
      if (roLaborRate > 0) break;
    }

    let cachedLaborRate = 0;
    if (needsCachedLaborRate({ source, jobLaborRate, roLaborRate })) {
      const db = await getDb();
      const shop = await db.collection("shops").findOne({ shopId }, { projection: { cachedLaborRate: 1 } });
      if (shop?.cachedLaborRate && shop.cachedLaborRate > 0) {
        cachedLaborRate = shop.cachedLaborRate;
      }
    }

    const { rate: shopLaborRate, rateSource } = resolveAddToRoLaborRate({
      source,
      jobLaborRate,
      roLaborRate,
      cachedLaborRate,
    });

    console.log(
      `[Ext Add-to-RO:${requestId}] Labor rate: $${shopLaborRate}/hr (source=${rateSource}, jobSource=${source || "unknown"})`
    );

    const jobLines = normalizeJobLines(job, shopLaborRate);

    // Task #681 — per-shop cost-estimate ratio for part lines without a real cost.
    const partCostRatio = await getShopPartCostRatio(shopId);

    const { randomUUID } = await import("crypto");

    const servicePackageLines = jobLines.map((line, idx) => {
      if (line.lineType === "labor") {
        const laborTotal = line.quantity * shopLaborRate;
        return {
          ID: randomUUID(),
          Rank: idx + 1,
          Type: "Labor",
          Description: line.description,
          Quantity: String(line.quantity),
          RateCode: "1",
          TechnicianHour: String(line.quantity),
          Price: String(shopLaborRate.toFixed(2)),
          Total: String(laborTotal.toFixed(2)),
          ExtendedTotal: String(laborTotal.toFixed(2)),
          MinimumCharge: 0,
          Discount: 0,
          TotalCost: String(laborTotal.toFixed(2)),
          Completed: false,
        };
      }
      // Task #681 — write the real part cost when the pushed line carries
      // one; otherwise estimate from retail via the shop's cost ratio.
      const resolvedCost = resolvePartLineCost(line, partCostRatio);
      logPartCostResolution({
        tag: `[Ext Add-to-RO:${requestId}]`,
        shopId,
        jobTitle: job.title,
        description: line.description,
        resolved: resolvedCost,
        ratio: partCostRatio,
        unitPrice: line.unitPrice,
      });
      return {
        ID: randomUUID(),
        Rank: idx + 1,
        Type: "Material",
        Description: line.description,
        Quantity: String(line.quantity),
        Unit: "Each",
        Price: String(line.unitPrice.toFixed(2)),
        Cost: String(resolvedCost.unitCost.toFixed(2)),
        Total: String(line.extendedPrice.toFixed(2)),
        ExtendedTotal: String(line.extendedPrice.toFixed(2)),
        TotalCost: String(resolvedCost.totalCost.toFixed(2)),
        PartNumber: line.partNumber || "",
        Manufacturer: line.manufacturer || "",
        MinimumCharge: 0,
        Discount: 0,
        Completed: false,
      };
    });

    // Task #1094: pin the package ID up front so it can be returned to the
    // extension for the side-panel undo snapshot (remove-from-ro uses it).
    const newServicePackageId = randomUUID();
    const newServicePackage = {
      ID: newServicePackageId,
      Chapter: "Service",
      Code: job.code || `MOS-${Date.now()}`,
      Rank: existingPackages.length + 1,
      ServicePackageHeader: {
        Title: job.title,
        Description: job.description ? `${job.description} [Added by MOS Extension]` : "[Added by MOS Extension]",
      },
      ServicePackageLines: {
        ItemCollection: servicePackageLines,
      },
    };

    const updatedWorkOrder = buildMinimalPayloadForPost(existingWorkOrder as any, existingPackages, newServicePackage);

    console.log(`[Ext Add-to-RO:${requestId}] POSTing "${job.title}" with ${servicePackageLines.length} lines...`);
    const postStart = Date.now();

    const updateResult = await protractorFetch<any>(
      `/WorkOrder/${workOrderGuid}`,
      config,
      { method: "POST", body: JSON.stringify(updatedWorkOrder) },
      0,
      shopId,
      { priority: true }
    );

    console.log(`[Ext Add-to-RO:${requestId}] POST took ${Date.now() - postStart}ms, ok=${updateResult.ok}`);

    if (!updateResult.ok) {
      const isStatusColumnError = (updateResult.error || "").includes("Invalid column name 'Status'");
      if (isStatusColumnError) {
        console.log(`[Ext Add-to-RO:${requestId}] REST failed with Status column error — SOAP fallback`);
        const soapResult = await soapAddServicePackage(shopId, workOrderGuid, updatedWorkOrder);
        if (!soapResult.ok) {
          return NextResponse.json(
            { error: "Failed to add job — Protractor database issue. Please contact Protractor support." },
            { status: 500, headers: corsHeaders }
          );
        }
      } else {
        return NextResponse.json(
          { error: updateResult.error || "Failed to add job to work order" },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    console.log(`[Ext Add-to-RO:${requestId}] Success: Added "${job.title}" to WO ${workOrderGuid}`);

    trackPushToRO({
      shopId,
      userId: auth.user.email || undefined,
      vin: vin || undefined,
      jobTitle: job.title,
      jobSource: "extension_protractor",
      repairOrderId: workOrderGuid,
    }).catch((err) => console.error("[Ext Add-to-RO] Analytics failed:", err));

    return NextResponse.json(
      {
        success: true,
        jobName: job.title,
        workOrderId: workOrderGuid,
        // Task #1094: lets the side panel snapshot this add for undo.
        servicePackageId: newServicePackageId,
      },
      { headers: corsHeaders }
    );
  } catch (err: any) {
    console.error(`[Ext Add-to-RO:${requestId}] Error:`, err.message);
    return NextResponse.json(
      { error: err.message || "Internal server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}

type NormalizedLine = {
  lineType: "labor" | "part" | "sublet" | "other";
  description: string;
  partNumber?: string;
  manufacturer?: string;
  quantity: number;
  unitPrice: number;
  extendedPrice: number;
  // Task #681 — real per-unit part cost, only set when known-real.
  cost?: number;
  extendedCost?: number;
};

// Task #888 — pull the pushed job's own labor rate out of either payload
// shape: full `lines` (labor unitPrice) or the sidepanel's `laborItems`
// (per-item `rate`, sent by newer extension builds for canned jobs).
function getExtensionJobLaborRate(job: {
  lines?: NormalizedLine[];
  laborItems?: Array<{ name: string; hours: number; rate?: number }>;
}): number {
  const fromLines = getJobLaborRate(job.lines);
  if (fromLines > 0) return fromLines;
  for (const item of job.laborItems || []) {
    const rate = parseFloat(String(item.rate ?? ""));
    if (Number.isFinite(rate) && rate > 0) return rate;
  }
  return 0;
}

function normalizeJobLines(
  job: {
    title: string;
    lines?: NormalizedLine[];
    laborItems?: Array<{ name: string; hours: number }>;
    parts?: Array<{
      name: string;
      partNumber?: string;
      brand?: string;
      quantity: number;
      cost: number;
      retail: number;
      unitCost?: number;
    }>;
  },
  laborRate: number
): NormalizedLine[] {
  if (job.lines && job.lines.length > 0) {
    return job.lines;
  }

  const lines: NormalizedLine[] = [];

  if (job.laborItems) {
    for (const item of job.laborItems) {
      const hours = parseFloat(String(item.hours)) || 1;
      lines.push({
        lineType: "labor",
        description: item.name || job.title,
        quantity: hours,
        unitPrice: laborRate,
        extendedPrice: hours * laborRate,
      });
    }
  }

  if (job.parts) {
    for (const part of job.parts) {
      const qty = parseInt(String(part.quantity)) || 1;
      const price = parseFloat(String(part.retail)) || parseFloat(String(part.cost)) || 0;
      // Task #681 — only `unitCost` is trusted as a real cost. The legacy
      // `cost` field is retail-contaminated on old extension builds (they
      // send `part.cost || part.unitPrice`), so it must never seed Cost.
      const unitCost = parseFloat(String(part.unitCost)) || 0;
      lines.push({
        lineType: "part",
        description: part.name,
        partNumber: part.partNumber || "",
        manufacturer: part.brand || "",
        quantity: qty,
        unitPrice: price,
        extendedPrice: qty * price,
        ...(unitCost > 0 ? { cost: unitCost, extendedCost: qty * unitCost } : {}),
      });
    }
  }

  if (lines.length === 0) {
    lines.push({
      lineType: "labor",
      description: job.title,
      quantity: 1,
      unitPrice: laborRate,
      extendedPrice: laborRate,
    });
  }

  return lines;
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
