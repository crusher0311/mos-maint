import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus } from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: getAuthErrorStatus(auth), headers: corsHeaders }
      );
    }

    const body = await request.json();
    const { provider, smsShopId, roId, vin, inspections } = body;

    if (!smsShopId || !roId) {
      return NextResponse.json(
        { error: "smsShopId and roId are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!inspections || !Array.isArray(inspections) || inspections.length === 0) {
      return NextResponse.json(
        { error: "inspections array is required and must not be empty" },
        { status: 400, headers: corsHeaders }
      );
    }

    const userShopIds = getUserShopIds(auth.user).map((id) => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    const shopResult = await findShopBySmsId(smsShopId, {
      userShopIds,
      isPlatformAdmin,
      providerHint: provider,
    });

    if (!shopResult) {
      return NextResponse.json(
        { error: "Shop not found or access denied" },
        { status: 403, headers: corsHeaders }
      );
    }

    const internalShopId = shopResult.mosShopId;
    const db = await getDb();

    let taskCount = 0;
    let redCount = 0;
    let yellowCount = 0;
    let greenCount = 0;
    for (const insp of inspections) {
      for (const group of insp.inspectionTasks || []) {
        for (const task of group.tasks || []) {
          taskCount++;
          const code = task.inspectionRating?.code;
          if (code === "RQRSATTN") redCount++;
          else if (code === "MAYRQRATTN") yellowCount++;
          else if (code === "CHCKD") greenCount++;
        }
      }
    }

    const result = await db.collection("tekmetric_work_orders").updateOne(
      {
        shopId: { $in: [String(internalShopId), Number(internalShopId)] },
        workOrderId: String(roId),
      },
      {
        $set: {
          dviDone: true,
          dviCompletedAt: new Date(),
          inspections: inspections,
          inspectionsCachedAt: new Date(),
          inspectionsCachedVia: "extension",
          ...(vin ? { vin: vin.toUpperCase() } : {}),
        },
      }
    );

    if (result.matchedCount === 0) {
      await db.collection("tekmetric_work_orders").updateOne(
        {
          shopId: { $in: [String(internalShopId), Number(internalShopId)] },
          workOrderId: String(roId),
        },
        {
          $set: {
            shopId: Number(internalShopId),
            workOrderId: String(roId),
            dviDone: true,
            dviCompletedAt: new Date(),
            inspections: inspections,
            inspectionsCachedAt: new Date(),
            inspectionsCachedVia: "extension",
            ...(vin ? { vin: vin.toUpperCase() } : {}),
            fetchedAt: new Date(),
          },
          $setOnInsert: {
            status: "Unknown",
            label: "",
          },
        },
        { upsert: true }
      );
    }

    console.log(
      `[Extension Inspections] Cached ${inspections.length} inspection(s) for RO ${roId} (shop ${internalShopId}): ` +
      `${taskCount} tasks (RED=${redCount}, YELLOW=${yellowCount}, GREEN=${greenCount}), ` +
      `matched=${result.matchedCount}, modified=${result.modifiedCount}`
    );

    return NextResponse.json(
      {
        ok: true,
        cached: true,
        mosShopId: internalShopId,
        stored: inspections.length,
        findings: { red: redCount, yellow: yellowCount, green: greenCount, total: taskCount },
        matched: result.matchedCount,
        modified: result.modifiedCount,
      },
      { headers: corsHeaders }
    );
  } catch (err: any) {
    console.error("[Extension Inspections] Error:", err.message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}
