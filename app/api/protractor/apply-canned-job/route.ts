import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  applyCannedJobToWorkOrder,
  fetchVehicleByVin,
  fetchWorkOrdersForVehicle,
} from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  let body: { vin?: string; cannedJobId?: string; workOrderId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { vin, cannedJobId, workOrderId } = body;

  if (!cannedJobId) {
    return NextResponse.json({ error: "cannedJobId is required" }, { status: 400 });
  }

  let targetWorkOrderId = workOrderId;

  if (!targetWorkOrderId && vin) {
    const vehicleResult = await fetchVehicleByVin(shopId, vin);
    if (!vehicleResult.ok || !vehicleResult.vehicle) {
      return NextResponse.json(
        { error: vehicleResult.error || "Vehicle not found in Protractor" },
        { status: 404 }
      );
    }

    const serviceItemId = vehicleResult.vehicle.ID;
    const workOrdersResult = await fetchWorkOrdersForVehicle(shopId, serviceItemId, {
      includeOpen: true,
    });

    if (!workOrdersResult.ok) {
      return NextResponse.json(
        { error: workOrdersResult.error || "Failed to fetch work orders" },
        { status: 500 }
      );
    }

    const openWorkOrders = (workOrdersResult.workOrders || []).filter(
      (wo) => !wo.Completed
    );

    if (openWorkOrders.length === 0) {
      return NextResponse.json(
        { error: "No open work order found for this vehicle" },
        { status: 404 }
      );
    }

    targetWorkOrderId = openWorkOrders[0].ID;
  }

  if (!targetWorkOrderId) {
    return NextResponse.json(
      { error: "Either workOrderId or vin must be provided" },
      { status: 400 }
    );
  }

  const result = await applyCannedJobToWorkOrder(shopId, targetWorkOrderId, cannedJobId);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  await db.collection("canned_job_applications").insertOne({
    shopId,
    vin: vin?.toUpperCase() || null,
    workOrderId: targetWorkOrderId,
    cannedJobId,
    servicePackageId: result.servicePackage?.ID || null,
    appliedAt: new Date(),
    appliedBy: session.email || null,
  });

  return NextResponse.json({
    success: true,
    workOrderId: targetWorkOrderId,
    servicePackage: result.servicePackage,
  });
}
