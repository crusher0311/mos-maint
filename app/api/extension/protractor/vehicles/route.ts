import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { fetchVehiclesByOwner } from "@/lib/integrations/protractor";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _GET(req: NextRequest) {
  try {
    const shopIdParam = req.nextUrl.searchParams.get("shopId");
    const ownerId = req.nextUrl.searchParams.get("ownerId");
    if (!shopIdParam) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!ownerId) {
      return NextResponse.json({ error: "ownerId is required" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: shopIdParam,
      provider: req.nextUrl.searchParams.get("provider") || "protractor",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const result = await fetchVehiclesByOwner(guard.mosShopId, ownerId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500, headers: corsHeaders });
    }

    const vehicles = (result.vehicles || []).map((v: any) => ({
      id: v.ID,
      vin: v.VIN || "",
      year: v.Year || null,
      make: v.Make || "",
      model: v.Model || "",
      submodel: v.Submodel || "",
      engine: v.Engine || "",
      color: v.Color || "",
      plate: v.LicensePlate || v.LookUp || v.Lookup || "",
      odometer: v.Usage || v.Odometer || null,
    }));

    return NextResponse.json({ vehicles }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[Extension Protractor Vehicles] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
