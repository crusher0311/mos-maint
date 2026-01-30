import { NextRequest, NextResponse } from "next/server";
import { trackPushToRO } from "@/lib/extension-analytics";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    const { shopId, userId, enterpriseId, vin, vehicleYear, vehicleMake, vehicleModel,
            jobTitle, jobSource, repairOrderId, laborAmount, partsAmount, totalAmount } = body;

    if (!shopId || !jobTitle || !jobSource) {
      return NextResponse.json(
        { error: "Missing required fields: shopId, jobTitle, jobSource" },
        { status: 400 }
      );
    }

    const validSources = ["plan", "failures", "lookup", "canned", "autocomplete", "deferred"];
    if (!validSources.includes(jobSource)) {
      return NextResponse.json(
        { error: `Invalid jobSource. Must be one of: ${validSources.join(", ")}` },
        { status: 400 }
      );
    }

    await trackPushToRO({
      shopId: Number(shopId),
      userId,
      enterpriseId,
      vin,
      vehicleYear: vehicleYear ? Number(vehicleYear) : undefined,
      vehicleMake,
      vehicleModel,
      jobTitle,
      jobSource,
      repairOrderId,
      laborAmount: laborAmount ? Number(laborAmount) : undefined,
      partsAmount: partsAmount ? Number(partsAmount) : undefined,
      totalAmount: totalAmount ? Number(totalAmount) : undefined,
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Error tracking push-to-ro:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
