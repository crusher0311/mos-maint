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
  const requestId = Math.random().toString(36).substring(7);
  const startTime = Date.now();
  console.log(`[Add-to-RO:${requestId}] Request received at ${new Date().toISOString()}`);
  
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

  console.log(`[Add-to-RO:${requestId}] Fetching WO ${workOrderGuid} for shop ${shopId}...`);
  const fetchWOStart = Date.now();
  const existingWOResult = await fetchWorkOrderById(shopId, workOrderGuid, { priority: true });
  console.log(`[Add-to-RO:${requestId}] WO fetch took ${Date.now() - fetchWOStart}ms`);
  if (!existingWOResult.ok || !existingWOResult.workOrder) {
    return NextResponse.json(
      { error: existingWOResult.error || "Work order not found" },
      { status: 404 }
    );
  }

  const existingWorkOrder = existingWOResult.workOrder;
  
  const workOrderType = existingWorkOrder.Type || (existingWorkOrder as any).type;
  const workOrderStage = existingWorkOrder.WorkflowStage || (existingWorkOrder as any).workflowStage;
  
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

  // Try to extract shop's current labor rate from existing work order lines
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
  
  // If no rate found from WO, use cached labor rate from shop document (fast)
  if (shopLaborRate === 0) {
    const { getDb } = await import("@/lib/mongo");
    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { cachedLaborRate: 1 } }
    );
    if (shop?.cachedLaborRate && shop.cachedLaborRate > 0) {
      shopLaborRate = shop.cachedLaborRate;
    }
  }
  
  // Final fallback: use historical rate from the job being added
  if (shopLaborRate === 0) {
    const laborLine = job.lines.find(l => l.lineType === "labor");
    if (laborLine && laborLine.unitPrice > 0) {
      shopLaborRate = laborLine.unitPrice;
    }
  }
  
  if (shopLaborRate > 0) {
    console.log(`[Jobs Add to RO] Using labor rate: $${shopLaborRate}/hr`);
  }

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
      // Use shop's labor rate (from WO or fallback to historical)
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
      ItemCollection: [...existingPackages, newServicePackage],
    },
  };

  console.log(`[Add-to-RO:${requestId}] Sending POST to add "${job.title}" with ${job.lines.length} lines...`);
  const postStart = Date.now();

  const updateResult = await protractorFetch<any>(
    `/WorkOrder/${workOrderGuid}`,
    config,
    {
      method: "POST",
      body: JSON.stringify(updatedWorkOrder),
    },
    0,
    shopId,
    { priority: true }
  );
  
  console.log(`[Add-to-RO:${requestId}] POST took ${Date.now() - postStart}ms`);

  if (!updateResult.ok) {
    console.log(`[Add-to-RO:${requestId}] Failed: ${updateResult.error}, total time: ${Date.now() - startTime}ms`);
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
  
  console.log(`[Add-to-RO:${requestId}] Success: Added "${job.title}" to WO ${workOrderGuid}, total time: ${Date.now() - startTime}ms`);

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
