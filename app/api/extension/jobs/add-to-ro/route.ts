import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus } from "@/lib/extension-auth";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  protractorFetch,
  fetchWorkOrderById,
  buildMinimalPayloadForPost,
  soapAddServicePackage,
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
  const requestId = Math.random().toString(36).substring(7);

  try {
    const auth = await validateExtensionToken(req);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: getAuthErrorStatus(auth), headers: corsHeaders }
      );
    }

    const body = await req.json();
    const { shopId, roNumber, vin, job } = body as {
      shopId: number;
      roNumber?: string;
      vin?: string;
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
        }>;
        laborItems?: Array<{ name: string; hours: number }>;
        parts?: Array<{
          name: string;
          partNumber?: string;
          brand?: string;
          quantity: number;
          cost: number;
          retail: number;
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

    if (sanitizedRoNumber) {
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

    let shopLaborRate = 0;
    for (const pkg of existingPackages) {
      const linesRaw = pkg.ServicePackageLines;
      const lines = Array.isArray(linesRaw) ? linesRaw : linesRaw?.ItemCollection || [];
      for (const line of lines) {
        if ((line.Type === "Labor" || line.LineType === "Labor") && line.Price && parseFloat(line.Price) > 0) {
          shopLaborRate = parseFloat(line.Price);
          break;
        }
      }
      if (shopLaborRate > 0) break;
    }

    if (shopLaborRate === 0) {
      const db = await getDb();
      const shop = await db.collection("shops").findOne({ shopId }, { projection: { cachedLaborRate: 1 } });
      if (shop?.cachedLaborRate && shop.cachedLaborRate > 0) {
        shopLaborRate = shop.cachedLaborRate;
      }
    }

    const jobLines = normalizeJobLines(job, shopLaborRate);

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
      return {
        ID: randomUUID(),
        Rank: idx + 1,
        Type: "Material",
        Description: line.description,
        Quantity: String(line.quantity),
        Unit: "Each",
        Price: String(line.unitPrice.toFixed(2)),
        Cost: String((line.unitPrice * 0.6).toFixed(2)),
        Total: String(line.extendedPrice.toFixed(2)),
        ExtendedTotal: String(line.extendedPrice.toFixed(2)),
        TotalCost: String((line.extendedPrice * 0.6).toFixed(2)),
        PartNumber: line.partNumber || "",
        Manufacturer: line.manufacturer || "",
        MinimumCharge: 0,
        Discount: 0,
        Completed: false,
      };
    });

    const newServicePackage = {
      ID: randomUUID(),
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
};

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
      lines.push({
        lineType: "part",
        description: part.name,
        partNumber: part.partNumber || "",
        manufacturer: part.brand || "",
        quantity: qty,
        unitPrice: price,
        extendedPrice: qty * price,
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
