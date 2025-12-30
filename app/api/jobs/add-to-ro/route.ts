// app/api/jobs/add-to-ro/route.ts
// Add historical job to an open work order

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { 
  resolveProtractorConfig, 
  fetchWorkOrderById,
  protractorFetch 
} from "@/lib/integrations/protractor";

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
  const { workOrderGuid, job } = body as { workOrderGuid: string; job: JobPayload };

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

  const mapLineType = (lineType: string): string => {
    switch (lineType) {
      case "labor": return "Labor";
      case "part": return "Part";
      case "sublet": return "Sublet";
      default: return "Other";
    }
  };

  const servicePackageLines = job.lines.map((line, idx) => {
    const baseLine = {
      ID: ZERO_GUID,
      Rank: idx + 1,
      Type: mapLineType(line.lineType),
      Description: line.description,
      Quantity: String(line.quantity),
      MinimumCharge: 0,
      Discount: 0,
      Total: String(line.extendedPrice.toFixed(2)),
      ExtendedTotal: String(line.extendedPrice.toFixed(2)),
      Completed: false,
    };

    if (line.lineType === "labor") {
      return {
        ...baseLine,
        RateCode: "1",
        TechnicianHour: String(line.quantity),
        TotalCost: String(line.extendedPrice.toFixed(2)),
      };
    } else {
      return {
        ...baseLine,
        Unit: "Each",
        Price: String(line.unitPrice.toFixed(2)),
        Cost: String((line.unitPrice * 0.6).toFixed(2)),
        TotalCost: String((line.extendedPrice * 0.6).toFixed(2)),
        PartNumber: line.partNumber || "",
        Manufacturer: line.manufacturer || "",
      };
    }
  });

  const existingPackagesRaw = existingWorkOrder.ServicePackages as any;
  const existingPackages = Array.isArray(existingPackagesRaw)
    ? existingPackagesRaw
    : (existingPackagesRaw?.ItemCollection || []);

  const newServicePackage = {
    ID: ZERO_GUID,
    Chapter: "Service",
    Code: job.code || `JL-${Date.now()}`,
    Rank: existingPackages.length + 1,
    Status: "Pending",
    ServicePackageHeader: {
      Title: job.title,
      Description: job.description || `Added from Job Lookup`,
    },
    ServicePackageLines: {
      ItemCollection: servicePackageLines,
    },
  };

  const updatedWorkOrder = {
    ...existingWorkOrder,
    ServicePackages: {
      ItemCollection: [...existingPackages, newServicePackage],
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

  return NextResponse.json({
    ok: true,
    message: `Added "${job.title}" to work order`,
    servicePackage: {
      title: job.title,
      linesAdded: job.lines.length,
    },
  });
}
