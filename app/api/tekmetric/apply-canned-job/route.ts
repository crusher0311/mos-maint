import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { addCannedJobsToRepairOrder } from "@/lib/tekmetric";
import { logRecommendationEvent } from "@/lib/enterprise";
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
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
  }

  const db = await getDb();
  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400, headers: corsHeaders });
  }

  const shop = await db.collection("shops").findOne({ shopId });
  const tekmetricShopId = shop?.tekmetric?.shopId || shop?.tekmetricShopId;
  
  if (!tekmetricShopId) {
    return NextResponse.json({ error: "Tekmetric not configured" }, { status: 400, headers: corsHeaders });
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
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
  }

  const { vin, cannedJobId, cannedJobTitle, repairOrderId } = body;
  console.log(`[Tekmetric Apply Canned Job] Request: vin=${vin}, cannedJobId=${cannedJobId}, repairOrderId=${repairOrderId}`);

  if (!cannedJobId) {
    return NextResponse.json({ error: "cannedJobId is required" }, { status: 400, headers: corsHeaders });
  }

  let targetRepairOrderId = repairOrderId ? Number(repairOrderId) : null;

  if (!targetRepairOrderId && vin) {
    const cached = await db.collection("tekmetric_work_orders").findOne({
      shopId: { $in: [String(shopId), Number(shopId)] },
      vin: vin.toUpperCase(),
      status: { $nin: ["Invoiced", "Void", "Archived"] }
    }, { sort: { fetchedAt: -1, updatedDate: -1 } });

    if (cached) {
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
      { status: 400, headers: corsHeaders }
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

    trackPushToRO({
      shopId,
      userId: session.email,
      vin: vin?.toUpperCase(),
      jobTitle: cannedJobTitle || `Canned Job ${cannedJobId}`,
      jobSource: "canned",
      repairOrderId: String(targetRepairOrderId),
    }).catch(err => console.error("[Tekmetric Apply Canned Job] Analytics tracking failed:", err));

    return NextResponse.json({
      success: true,
      repairOrderId: targetRepairOrderId,
      result,
    }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[Tekmetric Apply Canned Job] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500, headers: corsHeaders });
  }
}
