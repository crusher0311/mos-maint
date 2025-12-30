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
      case "labor": return "LaborLine";
      case "part": return "PartLine";
      case "sublet": return "SubletLine";
      default: return "OtherLine";
    }
  };

  const servicePackageLines = job.lines.map((line, idx) => ({
    ID: ZERO_GUID,
    Rank: idx + 1,
    Type: mapLineType(line.lineType),
    Description: line.description,
    Quantity: String(line.quantity),
    Unit: line.lineType === "labor" ? "Hour" : "Each",
    Price: line.unitPrice,
    PriceUnit: line.lineType === "labor" ? "Hour" : "Each",
    MinimumCharge: 0,
    Total: line.extendedPrice,
    Discount: 0,
    ExtendedTotal: line.extendedPrice,
    TotalCost: 0,
    PartNumber: line.partNumber || "",
    Manufacturer: line.manufacturer || "",
    Completed: false,
  }));

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

  console.log(`[Jobs Add to RO] Service package added successfully`);
  
  const responsePackages = updateResult.data?.ServicePackages?.ItemCollection || 
                           updateResult.data?.ServicePackages || [];
  const newPackage = Array.isArray(responsePackages) 
    ? responsePackages.find((p: any) => 
        p.ServicePackageHeader?.Title === job.title || 
        p.Code === newServicePackage.Code
      )
    : null;
  
  const servicePackageId = newPackage?.ID;
  
  if (servicePackageId && servicePackageId !== ZERO_GUID && job.lines.length > 0) {
    console.log(`[Jobs Add to RO] Adding ${job.lines.length} lines to service package ${servicePackageId}...`);
    
    let linesAdded = 0;
    const lineErrors: string[] = [];
    
    for (const line of servicePackageLines) {
      const linePayload = {
        ID: ZERO_GUID,
        WorkOrderID: workOrderGuid,
        ServicePackageID: servicePackageId,
        Type: line.Type,
        Description: line.Description,
        Quantity: line.Quantity,
        Unit: line.Unit,
        Price: line.Price,
        PriceUnit: line.PriceUnit,
        Total: line.Total,
        ExtendedTotal: line.ExtendedTotal,
        PartNumber: line.PartNumber,
        Manufacturer: line.Manufacturer,
        Completed: false,
      };
      
      const lineResult = await protractorFetch<any>(
        `/WorkOrder/ServicePackageLine`,
        config,
        {
          method: "POST",
          body: JSON.stringify(linePayload),
        }
      );
      
      if (lineResult.ok) {
        linesAdded++;
        console.log(`[Jobs Add to RO] Line added: ${line.Description}`);
      } else {
        lineErrors.push(`${line.Description}: ${lineResult.error}`);
        console.log(`[Jobs Add to RO] Line failed: ${line.Description} - ${lineResult.error}`);
      }
    }
    
    console.log(`[Jobs Add to RO] Lines added: ${linesAdded}/${job.lines.length}`);
    if (lineErrors.length > 0) {
      console.log(`[Jobs Add to RO] Line errors: ${lineErrors.join("; ")}`);
    }
  } else if (job.lines.length > 0) {
    console.log(`[Jobs Add to RO] Could not add lines - no valid ServicePackageID returned`);
  }

  console.log(`[Jobs Add to RO] Success: Added "${job.title}" to WO ${workOrderGuid}`);

  return NextResponse.json({
    ok: true,
    message: `Added "${job.title}" to work order`,
    servicePackage: {
      title: job.title,
      linesAdded: job.lines.length,
    },
  });
}
