import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { addCannedJobsToRepairOrder } from "@/lib/tekmetric";
import { logRecommendationEvent } from "@/lib/enterprise";

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

  const shop = await db.collection("shops").findOne({ shopId });
  const tekmetricShopId = shop?.tekmetric?.shopId || shop?.tekmetricShopId;
  
  if (!tekmetricShopId) {
    return NextResponse.json({ error: "Tekmetric not configured" }, { status: 400 });
  }

  let body: { 
    vin?: string; 
    cannedJobId?: string; 
    cannedJobTitle?: string; 
    repairOrderId?: string | number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { vin, cannedJobId, cannedJobTitle, repairOrderId } = body;
  console.log(`[Tekmetric Apply Canned Job] Request: vin=${vin}, cannedJobId=${cannedJobId}, repairOrderId=${repairOrderId}`);

  if (!cannedJobId) {
    return NextResponse.json({ error: "cannedJobId is required" }, { status: 400 });
  }

  let targetRepairOrderId = repairOrderId ? Number(repairOrderId) : null;

  if (!targetRepairOrderId && vin) {
    // Find most recent open work order for this VIN
    // Sort by fetchedAt (Date) for reliable ordering, filter out closed statuses
    const cached = await db.collection("tekmetric_work_orders").findOne({
      shopId: { $in: [String(shopId), Number(shopId)] },
      vin: vin.toUpperCase(),
      status: { $nin: ["Invoiced", "Void", "Archived"] }
    }, { sort: { fetchedAt: -1, updatedDate: -1 } });

    if (cached) {
      // workOrderId is stored as String(ro.id) in sync, convert back to number for Tekmetric API
      // Tekmetric uses numeric IDs (not GUIDs), so Number() conversion is safe
      const roIdFromWorkOrderId = cached.workOrderId ? Number(cached.workOrderId) : NaN;
      const roIdFromData = cached.data?.id ? Number(cached.data.id) : NaN;
      targetRepairOrderId = !isNaN(roIdFromWorkOrderId) ? roIdFromWorkOrderId : (!isNaN(roIdFromData) ? roIdFromData : null);
      console.log(`[Tekmetric Apply Canned Job] Found cached RO: ${targetRepairOrderId} from workOrderId: ${cached.workOrderId}, status: ${cached.status}`);
    }
  }

  if (!targetRepairOrderId) {
    return NextResponse.json(
      { 
        error: "No open repair order found for this vehicle. Please enter the RO number manually.",
        requiresManualEntry: true
      },
      { status: 400 }
    );
  }

  try {
    const result = await addCannedJobsToRepairOrder(targetRepairOrderId, [Number(cannedJobId)]);
    
    await db.collection("canned_job_applications").insertOne({
      shopId,
      tekmetricShopId,
      vin: vin?.toUpperCase() || null,
      repairOrderId: targetRepairOrderId,
      cannedJobId,
      provider: "tekmetric",
      appliedAt: new Date(),
      appliedBy: session.email || null,
    });

    try {
      await logRecommendationEvent({
        shopId,
        vin: vin?.toUpperCase() || "",
        workOrderId: String(targetRepairOrderId),
        provider: "tekmetric",
        eventType: "recommendation_added",
        recommendationType: "shop",
        serviceCode: cannedJobId,
        serviceName: cannedJobTitle || cannedJobId,
        addedBy: session.email || undefined,
      });
    } catch (err) {
      console.error("[Tekmetric Apply Canned Job] Failed to log recommendation event:", err);
    }

    return NextResponse.json({
      success: true,
      repairOrderId: targetRepairOrderId,
      result,
    });
  } catch (err: any) {
    console.error("[Tekmetric Apply Canned Job] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
