import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { 
  resolveProtractorConfig, 
  fetchWorkOrderById,
  protractorFetch 
} from "@/lib/integrations/protractor";
import sql from "@/lib/db/postgres";
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

type BatchJobRequest = {
  job: JobPayload;
  source?: "plan" | "failures" | "lookup" | "canned" | "autocomplete";
  vehicle?: { vin?: string; year?: number; make?: string; model?: string };
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
  const { workOrderGuid, jobs } = body as { 
    workOrderGuid: string; 
    jobs: BatchJobRequest[];
  };

  if (!workOrderGuid) {
    return NextResponse.json({ error: "Work order GUID is required" }, { status: 400 });
  }

  if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
    return NextResponse.json({ error: "At least one job is required" }, { status: 400 });
  }

  const existingWOResult = await fetchWorkOrderById(shopId, workOrderGuid);
  if (!existingWOResult.ok || !existingWOResult.workOrder) {
    return NextResponse.json(
      { error: existingWOResult.error || "Work order not found" },
      { status: 404 }
    );
  }

  const existingWorkOrder = existingWOResult.workOrder;
  
  const workOrderType = existingWorkOrder.Type;
  const workOrderStage = existingWorkOrder.WorkflowStage;
  
  console.log(`[Jobs Batch] WO ${workOrderGuid}: Type="${workOrderType}", Stage="${workOrderStage}", Jobs=${jobs.length}`);
  
  const allowedTypes = ["WorkOrder", "Estimate", "Appointment"];
  if (workOrderType && !allowedTypes.includes(workOrderType)) {
    return NextResponse.json(
      { error: `Cannot add to this work order - it's an ${workOrderType.toLowerCase()}, not an active work order` },
      { status: 400 }
    );
  }
  
  const blockedStages = ["WorkCompleted", "Invoiced", "Void", "Closed"];
  if (workOrderStage && blockedStages.includes(workOrderStage)) {
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

  let shopLaborRate = 0;
  for (const pkg of existingPackages) {
    const linesRaw = pkg.ServicePackageLines;
    const lines = Array.isArray(linesRaw) ? linesRaw : (linesRaw?.ItemCollection || []);
    for (const line of lines) {
      if ((line.Type === 'Labor' || line.LineType === 'Labor') && line.Price && parseFloat(line.Price) > 0) {
        shopLaborRate = parseFloat(line.Price);
        break;
      }
    }
    if (shopLaborRate > 0) break;
  }
  
  if (shopLaborRate === 0) {
    const shopRows = await sql`
      SELECT settings->'cachedLaborRate' as cached_labor_rate FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;
    const cachedRate = shopRows[0]?.cached_labor_rate;
    if (cachedRate && Number(cachedRate) > 0) {
      shopLaborRate = Number(cachedRate);
    }
  }
  
  if (shopLaborRate === 0) {
    for (const jobReq of jobs) {
      const laborLine = jobReq.job.lines.find(l => l.lineType === "labor");
      if (laborLine && laborLine.unitPrice > 0) {
        shopLaborRate = laborLine.unitPrice;
        break;
      }
    }
  }
  
  if (shopLaborRate > 0) {
    console.log(`[Jobs Batch] Using labor rate: $${shopLaborRate}/hr`);
  }

  const newServicePackages = jobs.map((jobReq, jobIndex) => {
    const job = jobReq.job;
    
    const servicePackageLines = job.lines.map((line, idx) => {
      if (line.lineType === "labor") {
        const laborTotal = line.quantity * shopLaborRate;
        return {
          ID: ZERO_GUID,
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
      } else {
        return {
          ID: ZERO_GUID,
          Rank: idx + 1,
          Type: mapLineType(line.lineType),
          Description: line.description,
          Quantity: String(line.quantity),
          Unit: "Each",
          Price: String(line.unitPrice.toFixed(2)),
          Cost: String((line.unitPrice * 0.6).toFixed(2)),
          Total: String(line.extendedPrice.toFixed(2)),
          ExtendedTotal: String(line.extendedPrice.toFixed(2)),
          TotalCost: String((line.extendedPrice * 0.6).toFixed(2)),
          MinimumCharge: 0,
          Discount: 0,
          PartNumber: line.partNumber || "",
          Manufacturer: line.manufacturer || "",
          Completed: false,
        };
      }
    });

    return {
      ID: ZERO_GUID,
      Chapter: "Service",
      Code: job.code || `JL-${Date.now()}-${jobIndex}`,
      Rank: existingPackages.length + jobIndex + 1,
      Status: "Pending",
      ServicePackageHeader: {
        Title: job.title,
        Description: job.description ? `${job.description} [Added by MOS]` : `[Added by MOS]`,
      },
      ServicePackageLines: {
        ItemCollection: servicePackageLines,
      },
    };
  });

  const updatedWorkOrder = {
    ...existingWorkOrder,
    ServicePackages: {
      ItemCollection: [...existingPackages, ...newServicePackages],
    },
  };

  const jobTitles = jobs.map(j => j.job.title).join(", ");
  console.log(`[Jobs Batch] Adding ${jobs.length} jobs to WO ${workOrderGuid}: ${jobTitles}`);

  const updateResult = await protractorFetch<any>(
    `/WorkOrder/${workOrderGuid}`,
    config,
    {
      method: "POST",
      body: JSON.stringify(updatedWorkOrder),
    }
  );

  if (!updateResult.ok) {
    console.log(`[Jobs Batch] Failed: ${updateResult.error}`);
    return NextResponse.json(
      { error: updateResult.error || "Failed to add jobs to work order" },
      { status: 500 }
    );
  }

  console.log(`[Jobs Batch] Success: Added ${jobs.length} jobs to WO ${workOrderGuid}`);

  for (const jobReq of jobs) {
    const job = jobReq.job;
    const totalAmount = job.lines.reduce((sum, line) => sum + (line.extendedPrice || 0), 0);
    const laborAmount = job.lines.filter(l => l.lineType === "labor").reduce((sum, l) => sum + (l.extendedPrice || 0), 0);
    const partsAmount = job.lines.filter(l => l.lineType === "part").reduce((sum, l) => sum + (l.extendedPrice || 0), 0);

    trackPushToRO({
      shopId,
      userId: session.email,
      vin: jobReq.vehicle?.vin,
      vehicleYear: jobReq.vehicle?.year,
      vehicleMake: jobReq.vehicle?.make,
      vehicleModel: jobReq.vehicle?.model,
      jobTitle: job.title,
      jobSource: jobReq.source || "lookup",
      repairOrderId: workOrderGuid,
      laborAmount,
      partsAmount,
      totalAmount,
    }).catch(err => console.error("[Jobs Batch] Analytics tracking failed:", err));
  }

  return NextResponse.json({
    ok: true,
    message: `Added ${jobs.length} job${jobs.length > 1 ? 's' : ''} to work order`,
    jobsAdded: jobs.length,
    jobs: jobs.map(j => ({ title: j.job.title, linesAdded: j.job.lines.length })),
  });
}
