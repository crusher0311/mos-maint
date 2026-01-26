// app/api/jobs/add-to-ro/route.ts
// Add historical job to an open work order

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { 
  resolveProtractorConfig, 
  fetchWorkOrderById,
  protractorFetch 
} from "@/lib/integrations/protractor";
import { trackPushToRO } from "@/lib/extension-analytics";

export const dynamic = "force-dynamic";

type JobLine = {
  lineType: "labor" | "part" | "sublet" | "other";
  description: string;
  partNumber?: string;
  manufacturer?: string;
  quantity: number;
  unitPrice: number;
  extendedPrice: number;
};

type JobPayload = {
  title: string;
  description?: string;
  code?: string;
  lines: JobLine[];
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const config = await resolveProtractorConfig(shopId);
  
  if (!config.configured) {
    return NextResponse.json(
      { error: "Protractor is not configured for this shop" },
      { status: 400 }
    );
  }

  const body = await req.json();
  const { workOrderGuid, job, source, vehicle } = body as { 
    workOrderGuid: string; 
    job: JobPayload;
    source?: "plan" | "failures" | "lookup" | "canned" | "autocomplete";
    vehicle?: { vin?: string; year?: number; make?: string; model?: string };
  };

  if (!workOrderGuid) {
    return NextResponse.json({ error: "Work order GUID is required" }, { status: 400 });
  }

  if (!job || !job.title) {
    return NextResponse.json({ error: "Job details are required" }, { status: 400 });
  }

  const existingWOResult = await fetchWorkOrderById(shopId, workOrderGuid);
  if (!existingWOResult.ok || !existingWOResult.workOrder) {
    return NextResponse.json(
      { error: existingWOResult.error || "Work order not found" },
      { status: 404 }
    );
  }

  const existingWorkOrder = existingWOResult.workOrder;
  
  const workOrderType = existingWorkOrder.Type || existingWorkOrder.type;
  const workOrderStage = existingWorkOrder.WorkflowStage || existingWorkOrder.workflowStage;
  
  console.log(`[Jobs Add to RO] WO ${workOrderGuid}: Type="${workOrderType}", Stage="${workOrderStage}"`);
  
  const allowedTypes = ["WorkOrder", "Estimate", "Appointment"];
  if (workOrderType && !allowedTypes.includes(workOrderType)) {
    console.log(`[Jobs Add to RO] Blocked: WO type "${workOrderType}" not allowed`);
    return NextResponse.json(
      { error: `Cannot add to this work order - it's an ${workOrderType.toLowerCase()}, not an active work order` },
      { status: 400 }
    );
  }
  
  const blockedStages = ["WorkCompleted", "Invoiced", "Void", "Closed"];
  if (blockedStages.includes(workOrderStage)) {
    console.log(`[Jobs Add to RO] Blocked: WO ${workOrderGuid} is in stage "${workOrderStage}"`);
    return NextResponse.json(
      { error: `Cannot add to this work order - it's already ${workOrderStage.replace(/([A-Z])/g, ' $1').trim().toLowerCase()}` },
      { status: 400 }
    );
  }
  const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

  const existingPackagesRaw = existingWorkOrder.ServicePackages as any;
  const existingPackages = Array.isArray(existingPackagesRaw)
    ? existingPackagesRaw
    : (existingPackagesRaw?.ItemCollection || []);

  const mapLineType = (lineType: string): string => {
    switch (lineType) {
      case "labor": return "Labor";
      case "part": return "Material";
      case "sublet": return "Sublet";
      default: return "Material";
    }
  };

  // Use unified line format - Protractor will apply shop's labor rate via RateCode
  const servicePackageLines = job.lines.map((line, idx) => ({
    ID: ZERO_GUID,
    Rank: idx + 1,
    Type: mapLineType(line.lineType),
    Description: line.description,
    Quantity: String(line.quantity),
    RateCode: "1",
    MinimumCharge: 0,
    Total: String(line.extendedPrice.toFixed(2)),
    Discount: 0,
    ExtendedTotal: String(line.extendedPrice.toFixed(2)),
    TotalCost: String(line.extendedPrice.toFixed(2)),
    PartNumber: line.partNumber || "",
    Manufacturer: line.manufacturer || "",
    Completed: false,
    TechnicianHour: line.lineType === "labor" ? String(line.quantity) : "0",
  }));

  const newServicePackage = {
    ID: ZERO_GUID,
    Chapter: "Service",
    Code: job.code || `JL-${Date.now()}`,
    Rank: existingPackages.length + 1,
    Status: "Pending",
    ServicePackageHeader: {
      Title: job.title,
      Description: job.description ? `${job.description} [Added by MOS]` : `[Added by MOS]`,
    },
    ServicePackageLines: {
      ItemCollection: servicePackageLines,
    },
  };

  const updatedWorkOrder = {
    ...existingWorkOrder,
    ServicePackages: {
      ItemCollection: [...existingPackagesForRate, newServicePackage],
    },
  };

  console.log(`[Jobs Add to RO] Adding "${job.title}" with ${job.lines.length} lines to WO ${workOrderGuid}...`);

  const updateResult = await protractorFetch<any>(
    `/WorkOrder/${workOrderGuid}`,
    config,
    {
      method: "POST",
      body: JSON.stringify(updatedWorkOrder),
    }
  );

  if (!updateResult.ok) {
    console.log(`[Jobs Add to RO] Failed: ${updateResult.error}`);
    return NextResponse.json(
      { error: updateResult.error || "Failed to add job to work order" },
      { status: 500 }
    );
  }

  const responsePackages = updateResult.data?.ServicePackages?.ItemCollection || 
                           updateResult.data?.ServicePackages || [];
  const addedPackage = Array.isArray(responsePackages) 
    ? responsePackages.find((p: any) => 
        p.ServicePackageHeader?.Title === job.title || 
        p.Code === newServicePackage.Code
      )
    : null;
  
  const linesInResponse = addedPackage?.ServicePackageLines?.ItemCollection?.length || 
                          addedPackage?.ServicePackageLines?.length || 0;
  
  console.log(`[Jobs Add to RO] Success: Added "${job.title}" with ${linesInResponse} lines to WO ${workOrderGuid}`);

  const totalAmount = job.lines.reduce((sum, line) => sum + (line.extendedPrice || 0), 0);
  const laborAmount = job.lines.filter(l => l.lineType === "labor").reduce((sum, l) => sum + (l.extendedPrice || 0), 0);
  const partsAmount = job.lines.filter(l => l.lineType === "part").reduce((sum, l) => sum + (l.extendedPrice || 0), 0);

  trackPushToRO({
    shopId,
    userId: session.email,
    vin: vehicle?.vin,
    vehicleYear: vehicle?.year,
    vehicleMake: vehicle?.make,
    vehicleModel: vehicle?.model,
    jobTitle: job.title,
    jobSource: source || "lookup",
    repairOrderId: workOrderGuid,
    laborAmount,
    partsAmount,
    totalAmount,
  }).catch(err => console.error("[Jobs Add to RO] Analytics tracking failed:", err));

  return NextResponse.json({
    ok: true,
    message: `Added "${job.title}" to work order`,
    servicePackage: {
      title: job.title,
      linesAdded: job.lines.length,
    },
  });
}
