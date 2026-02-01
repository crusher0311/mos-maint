import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { addCannedJobsToRepairOrder } from "@/lib/tekmetric";
import { logRecommendationEvent } from "@/lib/enterprise";
import { trackPushToRO } from "@/lib/extension-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = String(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${shopId}`;
  const shop = shopRows[0] as any;
  const tekmetricShopId = shop?.tekmetric?.shopId || shop?.tekmetric_shop_id;
  
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
    const cachedRows = await sql`
      SELECT * FROM tekmetric_work_orders
      WHERE shop_id = ${shopId}
        AND vin = ${vin.toUpperCase()}
        AND status NOT IN ('Invoiced', 'Void', 'Archived')
      ORDER BY fetched_at DESC, updated_date DESC
      LIMIT 1
    `;
    const cached = cachedRows[0] as any;

    if (cached) {
      const roIdFromWorkOrderId = cached.work_order_id ? Number(cached.work_order_id) : NaN;
      const roIdFromData = cached.data?.id ? Number(cached.data.id) : NaN;
      targetRepairOrderId = !isNaN(roIdFromWorkOrderId) ? roIdFromWorkOrderId : (!isNaN(roIdFromData) ? roIdFromData : null);
      console.log(`[Tekmetric Apply Canned Job] Found cached RO: ${targetRepairOrderId} from workOrderId: ${cached.work_order_id}, status: ${cached.status}`);
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
    
    await sql`
      INSERT INTO canned_job_applications (shop_id, tekmetric_shop_id, vin, repair_order_id, canned_job_id, provider, applied_at, applied_by)
      VALUES (${shopId}, ${String(tekmetricShopId)}, ${vin?.toUpperCase() || null}, ${String(targetRepairOrderId)}, ${cannedJobId}, 'tekmetric', NOW(), ${session.email || null})
    `;

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
      shopId: Number(shopId),
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
    });
  } catch (err: any) {
    console.error("[Tekmetric Apply Canned Job] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
