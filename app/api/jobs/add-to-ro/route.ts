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
    ServicePackageHeader: {
      Title: job.title,
      Description: job.description || `Added from Job Lookup`,
    },
    ServicePackageLines: {
      ItemCollection: servicePackageLines,
    },
  };

  const fullWorkOrderPayload = {
    ...existingWorkOrder,
    ID: workOrderGuid,
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
      body: JSON.stringify(fullWorkOrderPayload),
    }
  );

  if (!updateResult.ok) {
    console.log(`[Jobs Add to RO] Failed: ${updateResult.error}`);
    return NextResponse.json(
      { error: updateResult.error || "Failed to add job to work order" },
      { status: 500 }
    );
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
