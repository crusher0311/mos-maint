import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus, buildAuthErrorBody } from "@/lib/extension-auth";
import { trackPushToRO } from "@/lib/extension-analytics";

// Test seam: replaced in unit tests to avoid real DB / auth calls.
export const __deps = { validateExtensionToken, getAuthErrorStatus, buildAuthErrorBody, trackPushToRO };

async function _POST(request: NextRequest) {
  // Parse the body FIRST so we can extract shopId for the auth scope check.
  // validateExtensionToken(request, requiredShopId) verifies that the bearer
  // token belongs to a user whose accessible shops include requiredShopId —
  // preventing any valid extension token from writing analytics into another
  // shop's data.
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { shopId, userId, enterpriseId, vin, vehicleYear, vehicleMake, vehicleModel,
          jobTitle, jobSource, repairOrderId, laborAmount, partsAmount, totalAmount } = body as any;

  if (!shopId || !jobTitle || !jobSource) {
    return NextResponse.json(
      { error: "Missing required fields: shopId, jobTitle, jobSource" },
      { status: 400 }
    );
  }

  // Enforce that the authenticated extension user has access to the claimed shop.
  const auth = await __deps.validateExtensionToken(request, String(shopId));
  if (!auth.authorized) {
    return NextResponse.json(__deps.buildAuthErrorBody(auth), { status: __deps.getAuthErrorStatus(auth) });
  }

  try {
    const validSources = ["plan", "failures", "lookup", "canned", "autocomplete", "deferred"];
    if (!validSources.includes(jobSource)) {
      return NextResponse.json(
        { error: `Invalid jobSource. Must be one of: ${validSources.join(", ")}` },
        { status: 400 }
      );
    }

    await __deps.trackPushToRO({
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

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
